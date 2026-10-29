const path = require('path');
const express = require('express');
const config = require('./config');
const { pool } = require('./db');
const { requireAuth } = require('./middleware/auth');
const { checkSchema } = require('./services/schemaCheck');
const { HttpError, unauthorized, wrap } = require('./errors');

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // CORS: open to the whole network (any origin / IP / host name). Access is still protected by login.
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': req.get('origin') || '*', 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': req.get('access-control-request-headers') || '*', 'Access-Control-Max-Age': '600' });
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json({ limit: '100kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; media-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    });
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('x-forwarded-for');
      res.json({ status: 'ok', db: 'reachable', ...(local ? { media_root: config.mediaRoot, pid: process.pid } : {}) });
    } catch (err) {
      res.status(503).json({ status: 'error', db: 'unreachable', detail: err.message });
    }
  });

  app.use('/api/setup', require('./routes/setup'));   // first-run post registration (public, only while unbound)
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/media', require('./routes/media')); // token-authenticated, no bearer
  // Live stream. EventSource cannot send headers, so the browser first trades its session for a 60 s ticket.
  const live = require('./services/live');
  app.get('/api/stream', wrap(async (req, res) => {
    let p; try { p = live.readTicket(String(req.query.ticket || '')); } catch (_) { throw unauthorized('stream ticket expired - reconnect'); }
    const { rows } = await pool.query(`SELECT id, zone_id, post_id, status FROM users WHERE id = $1 AND role = 'post_user'`, [p.sub]);
    if (!rows.length || rows[0].status !== 'active') throw unauthorized('account not active');
    live.attach(req, res, rows[0]);
  }));

  const api = express.Router();
  api.use(requireAuth);
  api.post('/stream-ticket', (req, res) => res.json({ ticket: live.issueTicket(req.user) }));
  api.use('/', require('./routes/meta'));
  api.use('/alerts', require('./routes/alerts'));
  api.use('/incidents', require('./routes/incidents'));
  api.use('/requests', require('./routes/requests'));
  api.use('/footage', require('./routes/footage'));
  api.use('/flags', require('./routes/flags'));
  api.use('/notifications', require('./routes/notifications'));
  api.use('/audit', require('./routes/audit'));
  api.use('/team', require('./routes/team'));
  app.use('/api', api);

  app.use('/api', (req, res) => res.status(404).json({ error: 'no such endpoint' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));   // always revalidate: a stale script must never hide new features

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });
  return app;
}

/** Listen on PORT; if it is taken and PORT_AUTO is on (default in development), try the next ports. */
function listen(app) {
  return new Promise((resolve, reject) => {
    let port = config.port;
    const attempt = (left) => {
      const srv = app.listen(port);
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && left > 0) { console.warn(`port ${port} is busy - trying ${port + 1}`); port += 1; attempt(left - 1); return; }
        if (e.code === 'EADDRINUSE') {
          return reject(new Error(`port ${config.port} is already in use (another program, or an old RPF server).\n` +
            `  see what holds it:  ss -ltnp | grep ${config.port}\n  use another port:   PORT=7091 npm start      (or set PORT in .env)\n  or let it pick one: PORT_AUTO=1 npm start`));
        }
        reject(e);
      });
      srv.once('listening', () => resolve({ server: srv, port }));
    };
    attempt(config.portAuto ? 20 : 0);
  });
}

async function main() {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    console.error('JWT_SECRET is missing or shorter than 32 characters. Set it in .env (see .env.example).');
    process.exit(1);
  }
  const { missing, lacking } = await checkSchema();
  if (missing.length) {
    console.error('The connected database does not look like the CMS schema. Missing:\n  - ' + missing.join('\n  - '));
    console.error('RPF does not create schema. Point DB_* at the CMS database.');
    process.exit(1);
  }
  if (lacking.length) {
    console.warn('Warning: database role lacks privileges RPF needs:\n  - ' + lacking.join('\n  - '));
  }
  const { server, port } = await listen(buildApp());
  console.log(`RPF dashboard listening on port ${port}  (http://localhost:${port})`);
  const live = require('./services/live');
  live.start();
  process.on('SIGTERM', () => { live.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}

if (require.main === module) {
  main().catch((err) => { console.error('startup failed:', err.message); process.exit(1); });
}

module.exports = { buildApp };
