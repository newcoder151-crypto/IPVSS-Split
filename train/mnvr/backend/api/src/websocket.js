const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./config/security");

let wss = null;
const clients = new Map(); // userId -> Set<ws>

function setupWebSocket(server) {
  wss = new WebSocket.Server({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Token required");
      return;
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "railway-nvr-api",
      });
      ws.userId = decoded.sub;
      ws.role = decoded.role;
      ws.isAlive = true;

      // Track client
      if (!clients.has(decoded.sub)) clients.set(decoded.sub, new Set());
      clients.get(decoded.sub).add(ws);

      console.log(`[WS] Client connected: user=${decoded.username || decoded.sub}`);

      // Send welcome
      ws.send(
        JSON.stringify({
          type: "connection.established",
          data: { userId: decoded.sub, timestamp: new Date().toISOString() },
        }),
      );

      ws.on("pong", () => {
        ws.isAlive = true;
      });

      ws.on("message", (message) => {
        // OWASP A04 (Insecure Design): cap inbound message size to prevent a
        // single client from exhausting memory/CPU with oversized frames.
        if (message.length > 16 * 1024) {
          ws.send(JSON.stringify({ type: "error", data: { message: "Message too large" } }));
          return;
        }
        try {
          const msg = JSON.parse(message.toString());
          handleClientMessage(ws, msg);
        } catch (e) {
          ws.send(
            JSON.stringify({
              type: "error",
              data: { message: "Invalid JSON" },
            }),
          );
        }
      });

      ws.on("close", () => {
        console.log(`[WS] Client disconnected: user=${decoded.username || decoded.sub}`);
        const userClients = clients.get(decoded.sub);
        if (userClients) {
          userClients.delete(ws);
          if (userClients.size === 0) clients.delete(decoded.sub);
        }
      });
    } catch (err) {
      ws.close(4002, "Invalid token");
    }
  });

  // Heartbeat every 30s
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(interval));

  console.log("[WS] WebSocket server initialized");
}

function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case "subscribe.camera":
      ws.subscribedCameras = ws.subscribedCameras || new Set();
      ws.subscribedCameras.add(msg.data?.cameraId);
      ws.send(
        JSON.stringify({
          type: "subscribed",
          data: { camera: msg.data?.cameraId },
        }),
      );
      break;

    case "unsubscribe.camera":
      ws.subscribedCameras?.delete(msg.data?.cameraId);
      break;

    case "ping":
      ws.send(
        JSON.stringify({ type: "pong", data: { timestamp: Date.now() } }),
      );
      break;

    default:
      ws.send(
        JSON.stringify({
          type: "error",
          data: { message: `Unknown message type: ${msg.type}` },
        }),
      );
  }
}

// Broadcast to all connected clients
function broadcast(message) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

module.exports = { setupWebSocket, broadcast };
