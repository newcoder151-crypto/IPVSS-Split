import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  RefreshCw,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
  Network,
  Maximize2,
  Minimize2,
  AlertTriangle,
  Grid2x2,
  Grid3x3,
  LayoutGrid,
  Square,
  Columns2,
  PictureInPicture2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  X,
  Settings2,
  KeyRound,
  GripVertical,
  PlayCircle,
  ZoomIn,
  Volume2,
  VolumeX,
  Repeat,
  Search,
  ArrowLeft,
  Timer,
  Menu,
  ScanSearch,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useCameras,
  useCreateCamera,
  useUpdateCameraCredentials,
  type Camera,
  type CameraCreateInput,
} from "@/hooks/use-cameras";
import { CameraControlPanel } from "@/components/camera/CameraControlPanel";
import { DiscoverCameraDialog } from "@/components/camera/DiscoverCameraDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { apiGet } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

// These are only used as a fallback if the backend's own per-request URLs
// (cam.mediamtx.webrtc_url / hls_url, see backend/api/src/routes/mediamtx.js)
// aren't available yet. Deriving from window.location.hostname — the host
// the browser actually used to load this page — instead of hardcoding
// "localhost" means this still works when the dashboard is viewed from any
// machine other than the NVR box itself, which "localhost" never would.
const MTX_WEB =
  (import.meta.env.VITE_MEDIAMTX_WEB as string | undefined) ??
  `${window.location.protocol}//${window.location.hostname}:8889`;
const MTX_HLS =
  (import.meta.env.VITE_MEDIAMTX_HLS as string | undefined) ??
  `${window.location.protocol}//${window.location.hostname}:8888`;

type LayoutKey = "1x1" | "1+1" | "2x2" | "1+7" | "3x3" | "4x4";

const LAYOUTS: {
  key: LayoutKey;
  label: string;
  perPage: number;
  kind: "uniform" | "main-plus";
  cols?: number;
  icon: React.ElementType;
}[] = [
  { key: "1x1", label: "1×1", perPage: 1, kind: "uniform", cols: 1, icon: Square },
  { key: "1+1", label: "1+1", perPage: 2, kind: "uniform", cols: 2, icon: Columns2 },
  { key: "2x2", label: "2×2", perPage: 4, kind: "uniform", cols: 2, icon: Grid2x2 },
  { key: "1+7", label: "1+7", perPage: 8, kind: "main-plus", icon: PictureInPicture2 },
  { key: "3x3", label: "3×3", perPage: 9, kind: "uniform", cols: 3, icon: Grid3x3 },
  { key: "4x4", label: "4×4", perPage: 16, kind: "uniform", cols: 4, icon: LayoutGrid },
];

const AUTO_SWITCH_OPTIONS = [5, 10, 15, 30, 60];

// Returns `count` items starting at `offset` in `arr`, wrapping around the
// end back to the start — used by auto-switch to rotate which cameras
// occupy the (fixed) grid positions without touching page/layout state.
function rotateSlice<T>(arr: T[], offset: number, count: number): T[] {
  if (arr.length === 0) return [];
  if (arr.length <= count) return arr;
  const start = ((offset % arr.length) + arr.length) % arr.length;
  const doubled = [...arr, ...arr];
  return doubled.slice(start, start + count);
}

const TYPE_LABELS: Record<string, string> = {
  INTERIOR: "Interior",
  EXTERIOR: "Exterior",
  DOOR: "Door",
  DRIVER_CAB: "Driver Cab",
};

type CamWithMtx = Camera & {
  mediamtx?: {
    path_name: string;
    is_live: boolean;
    webrtc_url: string;
    hls_url: string;
    third_stream?: {
      path_name: string;
      is_live: boolean;
      webrtc_url: string;
      hls_url: string;
    };
  };
};

// ── Single camera tile ────────────────────────────────────────────────────────
interface TileProps {
  cam: CamWithMtx;
  compact: boolean;
  onExpand: (cam: CamWithMtx) => void;
  draggable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnter?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

function CameraTile({
  cam,
  compact,
  onExpand,
  draggable,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: TileProps) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const hlsRef = useRef<any>(null);
  const [connState, setConnState] = useState<
    "connecting" | "connected" | "failed" | "idle"
  >("idle");
  const [mode, setMode] = useState<"webrtc" | "hls" | "none">("none");
  const [retry, setRetry] = useState(0);

  // ── Hover-control state: audio, digital zoom, alternate stream ──────────
  const [audioOn, setAudioOn] = useState(false);
  const [source, setSource] = useState<"main" | "third">("main");
  const [zoomMode, setZoomMode] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panDragRef = useRef<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(null);

  const hasThirdStream = !!cam.mediamtx?.third_stream;
  const activeStream =
    source === "third" && cam.mediamtx?.third_stream
      ? cam.mediamtx.third_stream
      : cam.mediamtx;

  const whepUrl =
    activeStream?.webrtc_url ??
    `${MTX_WEB}/cam_${cam.camera_id}${source === "third" ? "_third" : ""}/whep`;
  const hlsUrl =
    activeStream?.hls_url ??
    `${MTX_HLS}/cam_${cam.camera_id}${source === "third" ? "_third" : ""}/index.m3u8`;

  const startHls = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setMode("hls");
    setConnState("connecting");
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      video.load();
      video
        .play()
        .then(() => setConnState("connected"))
        .catch(() => setConnState("failed"));
      return;
    }
    import("hls.js")
      .then(({ default: Hls }) => {
        if (!Hls.isSupported() || !videoRef.current) return;
        hlsRef.current?.destroy();
        const hls = new Hls({
          enableWorker: false,
          lowLatencyMode: true,
          backBufferLength: 10,
        });
        hlsRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoRef.current);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoRef.current
            ?.play()
            .then(() => setConnState("connected"))
            .catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          if (data.fatal) {
            setConnState("failed");
            setTimeout(() => setRetry((r) => r + 1), 4000);
          }
        });
      })
      .catch(() => setConnState("failed"));
  }, [hlsUrl]);

  const startWebRTC = useCallback(async () => {
    if (!videoRef.current) return;
    setConnState("connecting");
    pcRef.current?.close();
    pcRef.current = null;
    const pc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    pcRef.current = pc;
    // Guards against the "silent hang" failure mode: WHEP signaling can
    // succeed while MediaMTX still has nothing decodable to send this
    // browser (e.g. HEVC over WebRTC isn't universally supported). No
    // exception is thrown in that case, so ontrack just never fires — fall
    // back to HLS instead of waiting forever.
    const connectTimeout = setTimeout(() => {
      if (pcRef.current === pc) {
        pc.close();
        pcRef.current = null;
        startHls();
      }
    }, 6000);
    pc.ontrack = (ev) => {
      // ontrack fires once PER TRACK (audio and video separately). Only an
      // actual VIDEO track may mark this tile connected — an audio-only
      // track is ignored and connectTimeout keeps running so a real
      // fallback to HLS still happens if video never negotiates.
      if (ev.track.kind !== "video") return;
      if (videoRef.current) {
        clearTimeout(connectTimeout);
        const video = videoRef.current;
        video.srcObject = ev.streams[0];
        video.play().catch(() => {});
        setConnState("connected");
        setMode("webrtc");

        // DECODE WATCHDOG: a real video track negotiating only proves
        // signaling succeeded, not that the browser can actually decode
        // the codec being sent (Firefox + HEVC can get this far and then
        // never decode a frame). requestVideoFrameCallback confirms an
        // actual decoded frame; if none arrives, fall back to HLS.
        let frameSeen = false;
        const markFrameSeen = () => {
          frameSeen = true;
        };
        if (typeof (video as any).requestVideoFrameCallback === "function") {
          (video as any).requestVideoFrameCallback(markFrameSeen);
        } else {
          video.addEventListener("resize", markFrameSeen, { once: true });
        }
        setTimeout(() => {
          if (!frameSeen && pcRef.current === pc) {
            pc.close();
            pcRef.current = null;
            startHls();
          }
        }, 4000);
      }
    };
    pc.oniceconnectionstatechange = () => {
      // A video-only camera has nothing for MediaMTX to fall back to when
      // HEVC isn't a supported WebRTC output codec — the whole session
      // closes instead of just skipping a track. Retrying the same
      // negotiation just repeats the same failure, so fall back to HLS.
      if (
        ["failed", "disconnected", "closed"].includes(pc.iceConnectionState)
      ) {
        clearTimeout(connectTimeout);
        if (pcRef.current === pc) {
          pc.close();
          pcRef.current = null;
          startHls();
        }
      }
    };
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const resp = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!resp.ok) throw new Error(`WHEP ${resp.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await resp.text() });
    } catch {
      clearTimeout(connectTimeout);
      pc.close();
      pcRef.current = null;
      startHls();
    }
  }, [whepUrl, startHls]);

  useEffect(() => {
    if (cam.status !== "ACTIVE") {
      setMode("none");
      setConnState("idle");
      return;
    }
    startWebRTC();
    return () => {
      pcRef.current?.close();
      pcRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.src = "";
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam.camera_id, retry, source]);

  // ── Digital zoom: wheel to zoom, drag to pan, only while zoom mode is on ─
  const resetZoom = () => {
    setZoomLevel(1);
    setPan({ x: 0, y: 0 });
  };

  const handleWheelZoom = (e: React.WheelEvent) => {
    if (!zoomMode) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.25 : 0.25;
    setZoomLevel((z) => Math.max(1, Math.min(4, +(z + delta).toFixed(2))));
  };

  const handlePanStart = (e: React.PointerEvent) => {
    if (!zoomMode || zoomLevel <= 1) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    panDragRef.current = { startX: e.clientX, startY: e.clientY, origin: pan };
  };
  const handlePanMove = (e: React.PointerEvent) => {
    if (!panDragRef.current) return;
    const { startX, startY, origin } = panDragRef.current;
    setPan({ x: origin.x + (e.clientX - startX), y: origin.y + (e.clientY - startY) });
  };
  const handlePanEnd = () => {
    panDragRef.current = null;
  };

  const toggleAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    setAudioOn((a) => !a);
  };
  const toggleStream = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSource((s) => (s === "main" ? "third" : "main"));
  };
  const toggleZoomMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomMode((z) => {
      if (z) resetZoom();
      return !z;
    });
  };
  const goToPlayback = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/player?camera=${cam.camera_id}`);
  };

  return (
    <div
      draggable={draggable && !zoomMode}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={
        onDragOver ?? (draggable ? (e) => e.preventDefault() : undefined)
      }
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`relative bg-black rounded-lg overflow-hidden group border transition-all h-full w-full min-h-0 min-w-0 ${
        isDragging
          ? "opacity-40 border-primary/60"
          : isDropTarget
            ? "border-primary ring-2 ring-primary/50"
            : "border-transparent"
      }`}
      onWheel={handleWheelZoom}
    >
      <div
        className="w-full h-full overflow-hidden"
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerLeave={handlePanEnd}
        style={{ cursor: zoomMode && zoomLevel > 1 ? "grab" : undefined }}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-cover bg-black"
          muted={!audioOn}
          playsInline
          autoPlay
          style={{
            transform: `scale(${zoomLevel}) translate(${pan.x / zoomLevel}px, ${pan.y / zoomLevel}px)`,
            transition: panDragRef.current ? "none" : "transform 0.1s ease-out",
          }}
        />
      </div>

      {/* No signal overlay */}
      {connState !== "connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 pointer-events-none">
          {connState === "connecting" ? (
            <>
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mb-1" />
              <p className="text-[10px] text-white/60">Connecting…</p>
            </>
          ) : (
            <>
              <VideoOff className="h-5 w-5 text-white/30 mb-1" />
              <p className="text-[10px] text-white/40">
                {cam.status !== "ACTIVE" ? cam.status : "No signal"}
              </p>
            </>
          )}
        </div>
      )}

      {/* Top-left: drag handle + status */}
      <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
        {draggable && !zoomMode && (
          <span
            className="w-5 h-5 rounded bg-black/60 hover:bg-black/80 flex items-center justify-center text-white/70 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
            title="Drag to reorder"
          >
            <GripVertical className="h-3 w-3" />
          </span>
        )}
        {connState === "connected" && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/80 text-white font-medium">
            LIVE
          </span>
        )}
        {cam.is_recording === 1 && (
          <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-red-500/80 text-white font-medium animate-pulse">
            ● REC
          </span>
        )}
        {source === "third" && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/80 text-white font-medium">
            SUB
          </span>
        )}
      </div>

      {/* Hover controls: camera name, instant playback, digital zoom, audio, switch stream */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="w-6 h-6 rounded bg-black/60 hover:bg-black/80 flex items-center justify-center text-white"
          onClick={goToPlayback}
          title="Instant playback"
        >
          <PlayCircle className="h-3.5 w-3.5" />
        </button>
        <button
          className={`w-6 h-6 rounded flex items-center justify-center text-white ${zoomMode ? "bg-primary" : "bg-black/60 hover:bg-black/80"}`}
          onClick={toggleZoomMode}
          title="Digital zoom"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        {cam.audio_supported === 1 && (
          <button
            className="w-6 h-6 rounded bg-black/60 hover:bg-black/80 flex items-center justify-center text-white"
            onClick={toggleAudio}
            title={audioOn ? "Mute audio" : "Unmute audio"}
          >
            {audioOn ? (
              <Volume2 className="h-3.5 w-3.5" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {hasThirdStream && (
          <button
            className="w-6 h-6 rounded bg-black/60 hover:bg-black/80 flex items-center justify-center text-white"
            onClick={toggleStream}
            title="Switch stream"
          >
            <Repeat className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          className="w-6 h-6 rounded bg-black/60 hover:bg-black/80 flex items-center justify-center text-white"
          onClick={(e) => {
            e.stopPropagation();
            onExpand(cam);
          }}
          title="Expand"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Zoom mode pill */}
      {zoomMode && (
        <div className="absolute top-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/70 rounded-full px-2 py-0.5">
          <span className="text-[9px] text-white/80">
            {zoomLevel.toFixed(1)}x — scroll to zoom, drag to pan
          </span>
          <button
            className="text-white/70 hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              resetZoom();
            }}
            title="Reset zoom"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Bottom info — camera name always visible */}
      {!compact && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 pointer-events-none">
          <p className="text-xs font-semibold text-white leading-tight truncate">
            {cam.camera_name}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Network className="h-2.5 w-2.5 text-white/50 shrink-0" />
            <span className="text-[10px] font-mono text-white/60">
              {cam.ip_address || "—"}
            </span>
            {connState === "connected" ? (
              <Wifi className="h-2.5 w-2.5 text-green-400 ml-auto" />
            ) : (
              <WifiOff className="h-2.5 w-2.5 text-white/30 ml-auto" />
            )}
          </div>
        </div>
      )}
      {compact && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pointer-events-none">
          <p className="text-[10px] font-semibold text-white truncate">
            {cam.camera_name}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Expanded fullscreen dialog ─────────────────────────────────────────────────
function ExpandedDialog({
  cam,
  open,
  onClose,
}: {
  cam: CamWithMtx | null;
  open: boolean;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const hlsRef = useRef<any>(null);
  const [showControls, setShowControls] = useState(false);
  const [connState, setConnState] = useState<
    "connecting" | "connected" | "failed"
  >("connecting");
  const { toast } = useToast();
  const updateCredentials = useUpdateCameraCredentials();
  const [credsOpen, setCredsOpen] = useState(false);
  const [creds, setCreds] = useState({ username: "", password_hash: "" });

  // Reset controls when dialog closes/changes
  useEffect(() => {
    if (!open) {
      setShowControls(false);
      setConnState("connecting");
      setCredsOpen(false);
      setCreds({ username: "", password_hash: "" });
    }
  }, [open]);

  useEffect(() => {
    if (!open || !cam) return;

    const whepUrl =
      cam.mediamtx?.webrtc_url ?? `${MTX_WEB}/cam_${cam.camera_id}/whep`;
    const hlsUrl =
      cam.mediamtx?.hls_url ?? `${MTX_HLS}/cam_${cam.camera_id}/index.m3u8`;

    let cancelled = false;

    const startHlsFallback = () => {
      if (cancelled || !videoRef.current) return;
      const video = videoRef.current;
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
        video.load();
        video
          .play()
          .then(() => {
            if (!cancelled) setConnState("connected");
          })
          .catch(() => {
            if (!cancelled) setConnState("failed");
          });
        return;
      }
      import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled || !videoRef.current || !Hls.isSupported()) return;
          hlsRef.current?.destroy();
          const hls = new Hls({ enableWorker: false, lowLatencyMode: true });
          hlsRef.current = hls;
          hls.loadSource(hlsUrl);
          hls.attachMedia(videoRef.current);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            videoRef.current
              ?.play()
              .then(() => {
                if (!cancelled) setConnState("connected");
              })
              .catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (data.fatal && !cancelled) setConnState("failed");
          });
        })
        .catch(() => {
          if (!cancelled) setConnState("failed");
        });
    };

    const run = async () => {
      if (!videoRef.current) return;
      setConnState("connecting");

      const pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: "max-bundle",
      });
      pcRef.current = pc;

      const connectTimeout = setTimeout(() => {
        if (!cancelled && pcRef.current === pc) {
          pc.close();
          pcRef.current = null;
          startHlsFallback();
        }
      }, 6000);

      pc.ontrack = (ev) => {
        if (ev.track.kind !== "video") return;
        if (cancelled || !videoRef.current) return;
        clearTimeout(connectTimeout);
        videoRef.current.srcObject = ev.streams[0];
        videoRef.current
          .play()
          .then(() => {
            if (!cancelled) setConnState("connected");
          })
          .catch(() => {
            if (!cancelled) setConnState("connected");
          }); // still connected even if autoplay blocked
      };

      pc.oniceconnectionstatechange = () => {
        if (
          ["failed", "disconnected", "closed"].includes(
            pc.iceConnectionState,
          ) &&
          !cancelled
        ) {
          clearTimeout(connectTimeout);
          if (pcRef.current === pc) {
            pc.close();
            pcRef.current = null;
            startHlsFallback();
          }
        }
      };

      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const resp = await fetch(whepUrl, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: offer.sdp,
        });
        if (!resp.ok) throw new Error(`${resp.status}`);
        await pc.setRemoteDescription({
          type: "answer",
          sdp: await resp.text(),
        });
      } catch {
        clearTimeout(connectTimeout);
        pc.close();
        pcRef.current = null;
        startHlsFallback();
      }
    };

    // Small delay to ensure video element is mounted in DOM
    const timer = setTimeout(run, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      pcRef.current?.close();
      pcRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.src = "";
        videoRef.current.load();
      }
    };
  }, [open, cam?.camera_id]);

  if (!cam) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl bg-black border-border p-0 overflow-hidden max-h-[92vh] overflow-y-auto [&>button]:hidden">
        {/* Hidden title for accessibility */}
        <DialogTitle className="sr-only">
          {cam.camera_name} — expanded view
        </DialogTitle>

        {/* Custom header — close button placed with enough gap from content */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-sm font-semibold text-foreground truncate">
              {cam.camera_name}
            </p>
            <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
              <Network className="h-2.5 w-2.5 shrink-0" />
              {cam.ip_address || "—"} ·{" "}
              {cam.location_description || cam.camera_type}
            </p>
          </div>
          {/* Controls row: Controls toggle + close — with explicit gap so they never overlap */}
          <div className="flex items-center gap-3 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={() => {
                setCreds({ username: "", password_hash: "" });
                setCredsOpen(true);
              }}
              title="Fix this camera's RTSP/ONVIF username or password"
            >
              <KeyRound className="h-3.5 w-3.5" />
              Credentials
            </Button>
            <Button
              size="sm"
              variant={showControls ? "default" : "outline"}
              className="h-7 text-xs gap-1.5"
              onClick={() => setShowControls((s) => !s)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Controls
            </Button>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Video area */}
        <div className="relative bg-black" style={{ aspectRatio: "16/9" }}>
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            muted
            playsInline
            autoPlay
          />

          {/* Connecting / failed overlay */}
          {connState !== "connected" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
              {connState === "connecting" ? (
                <>
                  <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin mb-2" />
                  <p className="text-sm text-white/60">Connecting…</p>
                </>
              ) : (
                <>
                  <VideoOff className="h-8 w-8 text-white/30 mb-2" />
                  <p className="text-sm text-white/50">No signal</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* ONVIF Profile S controls: streams / PTZ / image / audio — toggled via "Controls" button */}
        {showControls && (
          <div className="px-4 py-3 bg-card border-t border-border">
            <CameraControlPanel
              cameraId={cam.camera_id}
              cameraName={cam.camera_name}
              ptzSupported={cam.ptz_supported === 1}
            />
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2 bg-card border-t border-border flex gap-4 text-[10px] text-muted-foreground flex-wrap">
          <span>
            WebRTC: {MTX_WEB}/cam_{cam.camera_id}/whep
          </span>
          <span>
            HLS: {MTX_HLS}/cam_{cam.camera_id}/index.m3u8
          </span>
        </div>
      </DialogContent>

      {/* Quick credential fix — the one thing that used to require psql.
          Leave a field blank to keep that value unchanged. */}
      <Dialog open={credsOpen} onOpenChange={setCredsOpen}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogTitle>Fix Credentials — {cam.camera_name}</DialogTitle>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const result = await updateCredentials.mutateAsync({
                  camera_id: cam.camera_id,
                  username: creds.username || undefined,
                  password_hash: creds.password_hash || undefined,
                });
                if (result.connectivity?.reachable) {
                  toast({ title: "Credentials updated — connected" });
                } else {
                  toast({
                    title: "Saved, but still couldn't connect",
                    description:
                      result.connectivity?.error ||
                      "Double-check the username/password against the camera itself.",
                    variant: "destructive",
                  });
                }
                setCredsOpen(false);
              } catch (err: any) {
                toast({
                  title: "Error",
                  description: err.message,
                  variant: "destructive",
                });
              }
            }}
          >
            <div>
              <Label className="text-xs">
                Username{" "}
                <span className="text-muted-foreground">
                  (leave blank to keep current)
                </span>
              </Label>
              <Input
                className="mt-1"
                autoComplete="off"
                value={creds.username}
                onChange={(e) =>
                  setCreds({ ...creds, username: e.target.value })
                }
              />
            </div>
            <div>
              <Label className="text-xs">
                Password{" "}
                <span className="text-muted-foreground">
                  (leave blank to keep current)
                </span>
              </Label>
              <Input
                className="mt-1"
                type="text"
                autoComplete="off"
                value={creds.password_hash}
                onChange={(e) =>
                  setCreds({ ...creds, password_hash: e.target.value })
                }
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Typed as plain text on purpose so you can see exactly what
                you're entering — watch out for autocorrect or stray characters.
              </p>
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={updateCredentials.isPending}
            >
              {updateCredentials.isPending
                ? "Testing connection…"
                : "Save & Test Connection"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

// ── Left tree view: cameras grouped by type ─────────────────────────────────
function CameraTree({
  cameras,
  focusedId,
  onSelect,
  search,
  onSearchChange,
  onCameraAdded,
}: {
  cameras: CamWithMtx[];
  focusedId: number | null;
  onSelect: (id: number) => void;
  search: string;
  onSearchChange: (v: string) => void;
  onCameraAdded: () => void;
}) {
  const { isAdmin } = useAuth();
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(Object.keys(TYPE_LABELS)),
  );
  const [discoverOpen, setDiscoverOpen] = useState(false);

  const filtered = cameras.filter((c) =>
    c.camera_name.toLowerCase().includes(search.toLowerCase()) ||
    (c.location_description || "").toLowerCase().includes(search.toLowerCase()),
  );

  const groups = filtered.reduce<Record<string, CamWithMtx[]>>((acc, c) => {
    const key = c.camera_type || "OTHER";
    (acc[key] ??= []).push(c);
    return acc;
  }, {});

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="w-60 shrink-0 border border-border rounded-lg bg-card flex flex-col min-h-0">
      <div className="p-2 border-b border-border space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search cameras…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        {isAdmin && (
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-xs gap-1.5"
            onClick={() => setDiscoverOpen(true)}
          >
            <ScanSearch className="h-3.5 w-3.5" />
            Discover & Add Camera
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {Object.keys(groups).length === 0 && (
          <p className="text-[11px] text-muted-foreground text-center py-4">
            No cameras match
          </p>
        )}
        {Object.entries(groups).map(([type, cams]) => (
          <div key={type} className="mb-0.5">
            <button
              onClick={() => toggleGroup(type)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground"
            >
              <span>{TYPE_LABELS[type] || type}</span>
              <span className="flex items-center gap-1">
                <span className="text-[10px] font-normal normal-case text-muted-foreground/70">
                  {cams.length}
                </span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${openGroups.has(type) ? "" : "-rotate-90"}`}
                />
              </span>
            </button>
            {openGroups.has(type) &&
              cams.map((cam) => (
                <button
                  key={cam.camera_id}
                  onClick={() => onSelect(cam.camera_id)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-muted/60 transition-colors ${
                    focusedId === cam.camera_id
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-foreground"
                  }`}
                >
                  <span
                    className={`status-dot ${
                      cam.status !== "ACTIVE"
                        ? "status-dot-red"
                        : cam.mediamtx?.is_live
                          ? "status-dot-green"
                          : "status-dot-yellow"
                    }`}
                    title={
                      cam.status !== "ACTIVE"
                        ? "Disabled"
                        : cam.mediamtx?.is_live
                          ? "Live"
                          : "Disconnected"
                    }
                  />
                  <span className="truncate flex-1">{cam.camera_name}</span>
                  {cam.is_recording === 1 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                  )}
                </button>
              ))}
          </div>
        ))}
      </div>

      {isAdmin && (
        <DiscoverCameraDialog
          open={discoverOpen}
          onClose={() => setDiscoverOpen(false)}
          onAdded={onCameraAdded}
        />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
const CameraGrid = () => {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const { data: dbCameras, isLoading, refetch } = useCameras();
  const createCamera = useCreateCamera();
  const pageRootRef = useRef<HTMLDivElement>(null);

  const [layout, setLayout] = useState<LayoutKey>("2x2");
  const [page, setPage] = useState(0);
  const [rotationOffset, setRotationOffset] = useState(0);
  const [expanded, setExpanded] = useState<CamWithMtx | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [emptyStateDiscoverOpen, setEmptyStateDiscoverOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [treeSearch, setTreeSearch] = useState("");
  const [treeSheetOpen, setTreeSheetOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(false);
  const [autoSwitchSec, setAutoSwitchSec] = useState(10);
  const [newCam, setNewCam] = useState<CameraCreateInput>({
    camera_name: "",
    camera_type: "INTERIOR",
    ip_address: "",
    rtsp_url: "",
    rec_rtsp_url: "",
    third_rtsp_url: "",
    username: "",
    password_hash: "",
    location_description: "",
  });

  const currentLayout = LAYOUTS.find((l) => l.key === layout)!;
  const perPage = currentLayout.perPage;

  const { data: mtxCameras, refetch: refetchMtx } = useQuery({
    queryKey: ["mediamtx-cameras"],
    queryFn: () =>
      apiGet<{ cameras: any[] }>("/api/mediamtx/cameras").catch(() => ({
        cameras: [],
      })),
    refetchInterval: 10000,
  });
  const { data: mtxStatus } = useQuery({
    queryKey: ["mediamtx-status"],
    // No .catch() here on purpose: on a transient failure (backend
    // restarting, brief network blip) React Query keeps showing the last
    // known-good value instead of us forcing it to {online:false} and
    // flashing a "streaming service unavailable" banner that isn't true.
    queryFn: () => apiGet<any>("/api/mediamtx/status"),
    refetchInterval: 15000,
    retry: 1,
  });

  const cameras: CamWithMtx[] = (dbCameras ?? [])
    .filter((c) => c.status === "ACTIVE")
    .map((cam) => ({
      ...cam,
      mediamtx: mtxCameras?.cameras?.find(
        (c: any) => c.camera_id === cam.camera_id,
      )?.mediamtx,
    }));

  const allCamerasForTree: CamWithMtx[] = (dbCameras ?? []).map((cam) => ({
    ...cam,
    mediamtx: mtxCameras?.cameras?.find(
      (c: any) => c.camera_id === cam.camera_id,
    )?.mediamtx,
  }));

  // ── Drag-and-drop tile ordering ──────────────────────────────────────────
  // Order is a list of camera IDs, persisted locally so the layout the
  // operator arranges sticks around across reloads. Cameras not yet present
  // in the saved order (new/newly-discovered ones) are appended at the end,
  // in their natural order, so nothing goes missing.
  const ORDER_STORAGE_KEY = "nvr:camera-grid-order";
  const [order, setOrder] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(ORDER_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      return [];
    }
  });
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);

  const orderedCameras = useMemo(() => {
    const byId = new Map(cameras.map((c) => [c.camera_id, c]));
    const ordered = order
      .map((id) => byId.get(id))
      .filter(Boolean) as typeof cameras;
    const seen = new Set(ordered.map((c) => c.camera_id));
    const rest = cameras.filter((c) => !seen.has(c.camera_id));
    return [...ordered, ...rest];
  }, [cameras, order]);

  const persistOrder = (ids: number[]) => {
    setOrder(ids);
    try {
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // Storage unavailable (private browsing, quota) — ordering just won't
      // persist across reloads; still works for the current session.
    }
  };

  const handleTileDrop = (targetId: number) => {
    if (draggedId === null || draggedId === targetId) {
      setDraggedId(null);
      setDropTargetId(null);
      return;
    }
    const ids = orderedCameras.map((c) => c.camera_id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from !== -1 && to !== -1) {
      ids.splice(from, 1);
      ids.splice(to, 0, draggedId);
      persistOrder(ids);
    }
    setDraggedId(null);
    setDropTargetId(null);
  };

  // Drag-and-drop props for a tile: the same for every layout (1x1 .. 4x4 and 1+7)
  const tileDragProps = (cam: CamWithMtx) => ({
    draggable: true,
    isDragging: draggedId === cam.camera_id,
    isDropTarget: dropTargetId === cam.camera_id && draggedId !== cam.camera_id,
    onDragStart: (e: React.DragEvent) => {
      setDraggedId(cam.camera_id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      if (draggedId !== null && draggedId !== cam.camera_id) setDropTargetId(cam.camera_id);
    },
    onDragLeave: () => setDropTargetId((t) => (t === cam.camera_id ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      handleTileDrop(cam.camera_id);
    },
    onDragEnd: () => {
      setDraggedId(null);
      setDropTargetId(null);
    },
  });

  // Auto switch: in every layout it rotates the whole fleet through the grid when there are more cameras than tiles.
  // In 1+7 it also works when everything fits: the big (main) tile then steps through the cameras, the rest shift along.
  const spotlight = layout === "1+7";
  const canAutoSwitch = spotlight ? orderedCameras.length > 1 : orderedCameras.length > perPage;
  const rotateBy = spotlight && orderedCameras.length <= perPage ? 1 : perPage;

  const totalPages = Math.max(1, Math.ceil(orderedCameras.length / perPage));
  const pageCams =
    autoSwitch && canAutoSwitch
      ? spotlight && orderedCameras.length <= perPage
        ? [...orderedCameras.slice(rotationOffset % orderedCameras.length), ...orderedCameras.slice(0, rotationOffset % orderedCameras.length)]
        : rotateSlice(orderedCameras, rotationOffset, perPage)
      : orderedCameras.slice(page * perPage, (page + 1) * perPage);

  const handleLayout = (key: LayoutKey) => {
    setLayout(key);
    setPage(0);
    setRotationOffset(0);
    setFocusedId(null);
  };

  // ── Auto-switch: the grid stays on the same page/layout — instead the set
  // of cameras shown in it rotates through the full fleet on a timer. This
  // only kicks in when there are more cameras than fit on screen at once. ──
  useEffect(() => {
    if (!autoSwitch || focusedId !== null || !canAutoSwitch) return;
    const total = orderedCameras.length;
    const id = setInterval(() => {
      setRotationOffset((o) => (o + rotateBy) % total);
    }, autoSwitchSec * 1000);
    return () => clearInterval(id);
  }, [autoSwitch, autoSwitchSec, rotateBy, canAutoSwitch, orderedCameras.length, focusedId]);

  // Auto-switch is meaningless when everything already fits on one page.
  useEffect(() => {
    if (!canAutoSwitch && autoSwitch) setAutoSwitch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoSwitch]);

  // ── Fullscreen: applies to the tree+grid+controls area only, so the app
  // header/sidebar stay hidden while the operator is watching cameras. ─────
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      pageRootRef.current?.requestFullscreen().catch(() => {
        toast({
          title: "Fullscreen unavailable",
          description: "This browser blocked the fullscreen request.",
          variant: "destructive",
        });
      });
    } else {
      document.exitFullscreen();
    }
  };

  const focusedCam = focusedId
    ? allCamerasForTree.find((c) => c.camera_id === focusedId) || null
    : null;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await createCamera.mutateAsync(newCam);
      // Tell the admin RIGHT NOW whether this camera actually connects,
      // instead of them finding out later from a blank tile — see
      // backend/api/src/services/rtspCheck.js for the probe itself.
      if (created.connectivity?.reachable) {
        toast({ title: "Camera added — connected, stream appears in ~15s" });
      } else if (created.connectivity) {
        toast({
          title: "Camera saved, but couldn't connect",
          description:
            created.connectivity.error ||
            "Check the IP, RTSP path, and credentials.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Camera added — stream appears in ~15s" });
      }
      setAddOpen(false);
      setNewCam({
        camera_name: "",
        camera_type: "INTERIOR",
        ip_address: "",
        rtsp_url: "",
        rec_rtsp_url: "",
        third_rtsp_url: "",
        username: "",
        password_hash: "",
        location_description: "",
      });
      setTimeout(() => {
        refetch();
        refetchMtx();
      }, 16000);
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    }
  };

  // Main-plus (1+7): 1 large tile (3x3 block) + 7 small tiles filling the
  // remaining right column (4 cells) and bottom row (3 cells) of a 4x4 grid.
  const renderMainPlus = () => {
    const [main, ...rest] = pageCams;
    if (!main) return null;
    return (
      <div
        className="grid gap-2 h-full"
        style={{
          gridTemplateColumns: "repeat(4, 1fr)",
          gridTemplateRows: "repeat(4, 1fr)",
        }}
      >
        <div className="h-full w-full min-h-0" style={{ gridColumn: "1 / span 3", gridRow: "1 / span 3" }}>
          <CameraTile cam={main} compact={false} onExpand={setExpanded} {...tileDragProps(main)} />
        </div>
        {rest.slice(0, 4).map((cam, i) => (
          <div key={cam.camera_id} className="h-full w-full min-h-0" style={{ gridColumn: "4", gridRow: `${i + 1}` }}>
            <CameraTile cam={cam} compact onExpand={setExpanded} {...tileDragProps(cam)} />
          </div>
        ))}
        {rest.slice(4, 7).map((cam, i) => (
          <div key={cam.camera_id} className="h-full w-full min-h-0" style={{ gridColumn: `${i + 1}`, gridRow: "4" }}>
            <CameraTile cam={cam} compact onExpand={setExpanded} {...tileDragProps(cam)} />
          </div>
        ))}
        {Array.from({ length: Math.max(0, 7 - rest.length) }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="bg-muted/20 rounded-lg"
            style={{
              gridColumn: rest.length + i < 4 ? "4" : `${rest.length + i - 3}`,
              gridRow: rest.length + i < 4 ? `${rest.length + i + 1}` : "4",
            }}
          />
        ))}
      </div>
    );
  };

  return (
    <AppLayout>
      <div
        ref={pageRootRef}
        className={`flex flex-col gap-3 ${isFullscreen ? "bg-background p-4 h-screen" : "h-full"}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2 shrink-0">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Camera View</h1>
            <p className="text-sm text-muted-foreground">
              {cameras.length} active {cameras.length === 1 ? "camera" : "cameras"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                refetch();
                refetchMtx();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Refresh
            </Button>

            {isAdmin && (
              <>
                <Button size="sm" className="gap-1" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add Camera
                </Button>

                {/* Add Camera Dialog */}
                <Dialog open={addOpen} onOpenChange={setAddOpen}>
                  <DialogContent className="bg-card border-border max-h-[90vh] overflow-y-auto">
                    <DialogTitle>Add Camera</DialogTitle>
                    <form onSubmit={handleAdd} className="space-y-3 mt-2">
                      <div>
                        <Label className="text-xs">Name</Label>
                        <Input
                          className="mt-1"
                          placeholder="CAM-01-INTERIOR"
                          required
                          value={newCam.camera_name}
                          onChange={(e) =>
                            setNewCam({ ...newCam, camera_name: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Type</Label>
                        <Select
                          value={newCam.camera_type}
                          onValueChange={(v) => setNewCam({ ...newCam, camera_type: v })}
                        >
                          <SelectTrigger className="mt-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["INTERIOR", "EXTERIOR", "DOOR", "DRIVER_CAB"].map((t) => (
                              <SelectItem key={t} value={t}>
                                {t}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">IP Address</Label>
                        <Input
                          className="mt-1"
                          placeholder="192.168.1.101"
                          value={newCam.ip_address}
                          onChange={(e) =>
                            setNewCam({ ...newCam, ip_address: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-xs">RTSP URL (live / sub-stream)</Label>
                        <Input
                          className="mt-1"
                          placeholder="rtsp://192.168.1.101:554/stream1"
                          required
                          value={newCam.rtsp_url}
                          onChange={(e) =>
                            setNewCam({ ...newCam, rtsp_url: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Recording URL{" "}
                          <span className="text-muted-foreground">(optional)</span>
                        </Label>
                        <Input
                          className="mt-1"
                          placeholder="rtsp://192.168.1.101:554/stream1 (leave blank to reuse live URL)"
                          value={newCam.rec_rtsp_url}
                          onChange={(e) =>
                            setNewCam({ ...newCam, rec_rtsp_url: e.target.value })
                          }
                        />
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          Dedicated main/recording-profile stream, if this camera
                          exposes one separately from live view.
                        </p>
                      </div>
                      <div>
                        <Label className="text-xs">
                          Third Stream URL{" "}
                          <span className="text-muted-foreground">(optional)</span>
                        </Label>
                        <Input
                          className="mt-1"
                          placeholder="rtsp://192.168.1.101:554/stream3"
                          value={newCam.third_rtsp_url}
                          onChange={(e) =>
                            setNewCam({ ...newCam, third_rtsp_url: e.target.value })
                          }
                        />
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          ONVIF "ThirdStream" profile (e.g. low-res analytics/mobile
                          feed), if the camera has one — enables the on-hover
                          "switch stream" control.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Username</Label>
                          <Input
                            className="mt-1"
                            placeholder="admin"
                            value={newCam.username}
                            onChange={(e) =>
                              setNewCam({ ...newCam, username: e.target.value })
                            }
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Password</Label>
                          <Input
                            className="mt-1"
                            type="password"
                            placeholder="••••••"
                            value={newCam.password_hash}
                            onChange={(e) =>
                              setNewCam({ ...newCam, password_hash: e.target.value })
                            }
                          />
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs">Location</Label>
                        <Input
                          className="mt-1"
                          placeholder="Coach S1 — Front"
                          value={newCam.location_description}
                          onChange={(e) =>
                            setNewCam({
                              ...newCam,
                              location_description: e.target.value,
                            })
                          }
                        />
                      </div>
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={createCamera.isPending}
                      >
                        Add Camera
                      </Button>
                      <p className="text-[10px] text-muted-foreground text-center">
                        Everything is saved from here — credentials and ONVIF
                        config are synced automatically, no need to add this
                        camera again in Settings.
                      </p>
                    </form>
                  </DialogContent>
                </Dialog>
              </>
            )}
          </div>
        </div>

        {/* MediaMTX offline warning */}
        {mtxStatus && !mtxStatus.online && (
          <Card className="border-yellow-500/30 bg-yellow-500/5 shrink-0">
            <CardContent className="p-3 flex items-center gap-3">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0" />
              <p className="text-sm text-yellow-700 dark:text-yellow-400">
                Streaming service unavailable — live view may not connect.
                Contact your system administrator if this persists.
              </p>
            </CardContent>
          </Card>
        )}

        {/* No cameras — the ONVIF "Discover & Add Camera" flow normally lives
            inside CameraTree, but CameraTree itself only renders once
            cameras.length > 0 below, which meant discovery was unreachable
            on a brand-new install with zero cameras (the empty-state text
            pointed at "Add Camera", which is only the manual-entry form).
            Surface both options directly here instead. */}
        {!isLoading && cameras.length === 0 && (
          <Card className="bg-card border-border">
            <CardContent className="py-16 text-center">
              <Video className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm text-foreground">No active cameras</p>
              {isAdmin && (
                <>
                  <p className="text-xs text-muted-foreground mt-1">
                    Add one manually, or scan the network with ONVIF discovery
                  </p>
                  <div className="flex items-center justify-center gap-2 mt-4">
                    <Button size="sm" className="gap-1" onClick={() => setAddOpen(true)}>
                      <Plus className="h-4 w-4" />
                      Add Camera
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => setEmptyStateDiscoverOpen(true)}
                    >
                      <ScanSearch className="h-3.5 w-3.5" />
                      Discover & Add Camera
                    </Button>
                  </div>
                  <DiscoverCameraDialog
                    open={emptyStateDiscoverOpen}
                    onClose={() => setEmptyStateDiscoverOpen(false)}
                    onAdded={() => {
                      refetch();
                      refetchMtx();
                    }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tree view + grid */}
        {cameras.length > 0 && (
          <div className="flex-1 flex gap-3 min-h-0">
            {/* Desktop tree — hidden on small screens, opened via Sheet instead */}
            <div className="hidden lg:flex">
              <CameraTree
                cameras={allCamerasForTree}
                focusedId={focusedId}
                onSelect={(id) => setFocusedId(id)}
                search={treeSearch}
                onSearchChange={setTreeSearch}
                onCameraAdded={() => {
                  refetch();
                  refetchMtx();
                }}
              />
            </div>

            {/* Mobile / tablet: tree lives in a slide-over Sheet */}
            <Sheet open={treeSheetOpen} onOpenChange={setTreeSheetOpen}>
              <SheetContent side="left" className="w-72 p-0 lg:hidden">
                <SheetTitle className="sr-only">Cameras</SheetTitle>
                <div className="h-full p-3">
                  <CameraTree
                    cameras={allCamerasForTree}
                    focusedId={focusedId}
                    onSelect={(id) => {
                      setFocusedId(id);
                      setTreeSheetOpen(false);
                    }}
                    search={treeSearch}
                    onSearchChange={setTreeSearch}
                    onCameraAdded={() => {
                      refetch();
                      refetchMtx();
                    }}
                  />
                </div>
              </SheetContent>
            </Sheet>

            <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
              <div className="flex items-center gap-2 lg:hidden shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setTreeSheetOpen(true)}
                >
                  <Menu className="h-3.5 w-3.5" />
                  Cameras
                </Button>
              </div>

              {focusedCam ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit gap-1.5"
                    onClick={() => setFocusedId(null)}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to grid
                  </Button>
                  <div className="flex-1 min-h-0">
                    <CameraTile
                      cam={focusedCam}
                      compact={false}
                      onExpand={setExpanded}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex-1 min-h-0">
                    {currentLayout.kind === "main-plus" ? (
                      renderMainPlus()
                    ) : (
                      <div
                        className="grid gap-2 h-full w-full"
                        style={{
                          gridTemplateColumns: `repeat(${currentLayout.cols}, 1fr)`,
                          gridTemplateRows: `repeat(${Math.ceil(perPage / (currentLayout.cols || 1))}, 1fr)`,
                        }}
                      >
                        {pageCams.map((cam) => (
                          <CameraTile
                            key={cam.camera_id}
                            cam={cam}
                            compact={layout === "3x3" || layout === "4x4"}
                            onExpand={setExpanded}
                            {...tileDragProps(cam)}
                          />
                        ))}
                        {Array.from({ length: perPage - pageCams.length }).map((_, i) => (
                          <div key={`empty-${i}`} className="bg-muted/20 rounded-lg h-full w-full" />
                        ))}
                      </div>
                    )}
                  </div>

                  {autoSwitch && canAutoSwitch && (
                    <p className="text-[11px] text-muted-foreground text-center shrink-0">
                      {spotlight && orderedCameras.length <= perPage ? `Auto-switching the main camera every ${autoSwitchSec}s` : `Auto-switching cameras every ${autoSwitchSec}s`} — grid position stays fixed
                    </p>
                  )}

                  {!autoSwitch && totalPages > 1 && (
                    <div className="flex items-center justify-between shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={page === 0}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                        Prev
                      </Button>
                      <div className="flex items-center gap-1">
                        {Array.from({ length: totalPages }).map((_, i) => (
                          <button
                            key={i}
                            onClick={() => setPage(i)}
                            className={`w-2 h-2 rounded-full transition-colors ${i === page ? "bg-primary" : "bg-muted hover:bg-muted-foreground/40"}`}
                          />
                        ))}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={page === totalPages - 1}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next
                        <ChevronRight className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Bottom control bar */}
        {cameras.length > 0 && !focusedCam && (
          <div className="shrink-0 flex items-center justify-between flex-wrap gap-2 border border-border rounded-lg bg-card px-3 py-2">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Window division / layout picker */}
              <div className="flex items-center border border-border rounded-md overflow-hidden">
                {LAYOUTS.map(({ key, label, icon: Icon }) => (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleLayout(key)}
                        className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-colors ${layout === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Window division: {label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>

              {/* Auto switch */}
              <div className="flex items-center gap-2 border border-border rounded-md px-2.5 py-1.5">
                <Timer className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Auto switch</span>
                <Switch
                  checked={autoSwitch}
                  onCheckedChange={setAutoSwitch}
                  disabled={!canAutoSwitch}
                />
                <Select
                  value={String(autoSwitchSec)}
                  onValueChange={(v) => setAutoSwitchSec(Number(v))}
                  disabled={!autoSwitch}
                >
                  <SelectTrigger className="h-7 w-20 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTO_SWITCH_OPTIONS.map((s) => (
                      <SelectItem key={s} value={String(s)} className="text-xs">
                        {s}s
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {orderedCameras.length > 1 && (
                <p className="text-[11px] text-muted-foreground">
                  Drag a tile to reorder
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <p className="text-[11px] text-muted-foreground hidden md:block">
                {autoSwitch
                  ? `Auto-switch on · ${cameras.length} cameras · ${perPage} per page`
                  : `Page ${page + 1} of ${totalPages} · ${cameras.length} cameras · ${perPage} per page`}
              </p>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={toggleFullscreen}>
                {isFullscreen ? (
                  <>
                    <Minimize2 className="h-3.5 w-3.5" />
                    Exit Full Screen
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3.5 w-3.5" />
                    Full Screen
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ExpandedDialog
        cam={expanded}
        open={!!expanded}
        onClose={() => setExpanded(null)}
      />
    </AppLayout>
  );
};

export default CameraGrid;
