const { execFile } = require('child_process');

// Mirrors mediamtx-sync.py's build_rtsp_url_with_creds() exactly — same
// percent-encoding approach, never raw string concatenation. Raw
// concatenation is what caused the earlier "credential-doubling" bug for
// passwords containing '@' (see mediamtx-sync.py comment). Kept as its own
// function here (not shared with the Python side) since this only needs to
// answer one question — "does this camera actually respond?" — at save
// time, using the exact same credentials the streaming pipeline will use.
function buildRtspUrlWithCreds(rtspUrl, user, pass) {
  if (!user || !pass) return rtspUrl;
  try {
    const u = new URL(rtspUrl);
    if (u.username) return rtspUrl; // URL already carries its own credentials
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pass);
    return u.toString();
  } catch {
    return rtspUrl; // malformed URL — let the caller's own validation catch it
  }
}

// Never let a credential-bearing RTSP URL reach a log line or an HTTP
// response body — mask it the same way regardless of success/failure path.
function maskCredentials(rtspUrl) {
  try {
    const u = new URL(rtspUrl);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return String(rtspUrl || '').replace(/\/\/[^@/]+@/, '//***:***@');
  }
}

function sanitizeFfmpegError(text, rtspUrl) {
  let msg = String(text || '').trim().split('\n').filter(Boolean).pop() || 'Connection failed';
  // Some ffprobe error paths echo the input URL (credentials and all) back
  // into stderr — strip any literal occurrence before this can leak out.
  if (rtspUrl) msg = msg.split(rtspUrl).join(maskCredentials(rtspUrl));
  return msg.slice(0, 200);
}

// Runs a short, bounded RTSP probe using ffprobe (already a hard dependency
// of this project — stream_manager.py/mediamtx-sync.py both assume ffmpeg
// is installed). Uses execFile with an argument array, NOT a shell string —
// camera-supplied IP/username/password can contain shell metacharacters,
// and execFile bypasses the shell entirely so there's no injection surface
// here (OWASP A03).
function checkRtspConnectivity(rtspUrl, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-show_streams',
      '-v', 'error',
      '-of', 'json',
    ], { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        resolve({ reachable: false, error: sanitizeFfmpegError(stderr || err.message, rtspUrl) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const hasStream = Array.isArray(parsed.streams) && parsed.streams.length > 0;
        const video = hasStream ? parsed.streams.find((s) => s.codec_type === 'video') : null;
        resolve({
          reachable: hasStream,
          error: hasStream ? null : 'Connected, but the camera reported no media streams',
          video: video ? { codec: video.codec_name, width: video.width || null, height: video.height || null } : null,
          has_audio: hasStream && parsed.streams.some((s) => s.codec_type === 'audio'),
        });
      } catch {
        resolve({ reachable: false, error: 'Unexpected response while probing the camera' });
      }
    });
  });
}

/**
 * Takes an RTSP URL typed by a person (with or without user:password@) and splits it into what the NVR stores:
 * the URL without credentials, the credentials, host and port. Only rtsp:// and rtsps:// are accepted.
 */
function splitRtspUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new Error('That is not a valid URL. Example: rtsp://192.168.1.20:554/stream1'); }
  if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') throw new Error('The address must start with rtsp:// (or rtsps://)');
  if (!u.hostname) throw new Error('The RTSP address has no host');
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const username = u.username ? decode(u.username) : '';
  const password = u.password ? decode(u.password) : '';
  const port = u.port ? Number(u.port) : 554;
  u.username = ''; u.password = '';
  return { url: u.toString(), username, password, host: u.hostname, port };
}

module.exports = { checkRtspConnectivity, buildRtspUrlWithCreds, maskCredentials, splitRtspUrl };
