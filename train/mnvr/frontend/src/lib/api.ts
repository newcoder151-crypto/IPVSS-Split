/**
 * Central API client.
 * In Docker: VITE_API_URL="" so all /api/* calls are proxied by nginx.
 * In dev:    VITE_API_URL="http://localhost:3001"
 */

export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const tokenStore = {
  get:   (): string | null => localStorage.getItem('nvr_token'),
  set:   (t: string)       => localStorage.setItem('nvr_token', t),
  clear: ()                => localStorage.removeItem('nvr_token'),
};

// Lets AuthContext react immediately when a session goes invalid (expired
// token on a protected call), instead of only finding out on the next
// manual page load/refresh. signOut() also calls this path indirectly by
// clearing user state itself — this handles the *other* direction: the
// server telling us the token is no longer good.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

// The server blocks every call except change-password until the signed-in user has replaced a default/temporary password
// (403 + code MUST_CHANGE_PASSWORD). AuthContext reacts by showing the change-password screen instead of letting each page
// fail with a confusing error.
let onMustChangePassword: (() => void) | null = null;
export function setMustChangePasswordHandler(fn: (() => void) | null): void {
  onMustChangePassword = fn;
}

// Endpoints where a 401 is an ordinary, expected outcome (wrong password,
// self-registration correctly refused) — NOT a sign that a previously-valid
// session just expired. These must be left alone for the caller's own
// try/catch to handle and display, rather than being treated as "your
// session is dead, log out and reload."
const AUTH_ENDPOINTS_EXEMPT_FROM_AUTO_LOGOUT = ['/api/auth/login', '/api/auth/register'];

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = tokenStore.get();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  const isExempt = AUTH_ENDPOINTS_EXEMPT_FROM_AUTO_LOGOUT.some((p) => path.startsWith(p));
  if (res.status === 401 && !isExempt) {
    // Clear the dead token and let React (AuthContext + the route guard)
    // handle navigation reactively via the router — no hard page reload,
    // which is what was previously wiping out in-flight error messages and
    // making sign-out feel like it needed a manual refresh to "take".
    tokenStore.clear();
    onUnauthorized?.();
  }
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => null);
    if (body && body.code === 'MUST_CHANGE_PASSWORD') onMustChangePassword?.();
  }
  return res;
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as any).error || `HTTP ${res.status}`);
    // Callers (AuthContext in particular) need to tell "the token is
    // actually invalid" (401) apart from "the request failed for some
    // other reason" (backend restarting, network blip, 500, etc.) — only
    // the former should ever trigger clearing a saved session.
    (err as any).status = res.status;
    throw err;
  }
  return body as T;
}

export const apiGet    = <T>(p: string)                  => apiFetch(p)                                       .then(r => parseOrThrow<T>(r));
export const apiPost   = <T>(p: string, b: unknown)      => apiFetch(p, { method: 'POST', body: JSON.stringify(b) }).then(r => parseOrThrow<T>(r));
export const apiPut    = <T>(p: string, b: unknown)      => apiFetch(p, { method: 'PUT',  body: JSON.stringify(b) }).then(r => parseOrThrow<T>(r));
export const apiDelete = <T>(p: string)                  => apiFetch(p, { method: 'DELETE' })                 .then(r => parseOrThrow<T>(r));
export const apiPostForm = <T>(p: string, fd: FormData)  => apiFetch(p, { method: 'POST', body: fd, headers: {} }).then(r => parseOrThrow<T>(r));

// ── Streaming URL helpers ──────────────────────────────────────────────────────
//
// A <video>/<img> src can't attach an Authorization header, so it has to
// carry its token in the URL. The backend now rejects a raw login token used
// this way (it leaks into logs/history/Referer) and only accepts a separate,
// short-lived (5 min), narrowly-scoped "media token" fetched from
// /api/auth/media-token. This module fetches and caches that token, and
// refreshes it in the background before it expires, so getStreamUrl/
// getDownloadUrl/getHlsUrl can stay synchronous — no changes needed at any
// call site that already does <video src={getStreamUrl(id)}>.
let mediaToken: string | null = null;
let mediaTokenExpiresAt = 0;
let mediaTokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshMediaToken(): Promise<void> {
  const loginToken = tokenStore.get();
  if (!loginToken) { mediaToken = null; return; }
  try {
    const res = await fetch(`${API_BASE}/api/auth/media-token`, {
      headers: { Authorization: `Bearer ${loginToken}` },
    });
    if (!res.ok) { mediaToken = null; return; }
    const data = await res.json() as { token: string; expires_in: number };
    mediaToken = data.token;
    // Refresh 30s before actual expiry so an in-flight video load never
    // races against the token going stale mid-request.
    mediaTokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
    if (mediaTokenRefreshTimer) clearTimeout(mediaTokenRefreshTimer);
    mediaTokenRefreshTimer = setTimeout(refreshMediaToken, (data.expires_in - 30) * 1000);
  } catch {
    mediaToken = null;
  }
}

// Kick off a fetch if we don't have a live token yet — fire-and-forget, since
// tok() below must stay synchronous. On first-ever call this can return a
// stale/empty token; ensureMediaTokenReady() (exported below) lets a
// component await readiness once at mount if it wants a guarantee before
// rendering the <video> at all.
function ensureMediaToken(): void {
  if (!mediaToken || Date.now() > mediaTokenExpiresAt) {
    void refreshMediaToken();
  }
}

export function ensureMediaTokenReady(): Promise<void> {
  if (mediaToken && Date.now() < mediaTokenExpiresAt) return Promise.resolve();
  return refreshMediaToken();
}

// Warm the cache immediately whenever a login token becomes available (page
// load with an existing session, or a fresh login) instead of waiting for
// the first video click.
if (tokenStore.get()) void refreshMediaToken();
const _origSet = tokenStore.set;
tokenStore.set = (t: string) => { _origSet(t); void refreshMediaToken(); };
const _origClear = tokenStore.clear;
tokenStore.clear = () => {
  _origClear();
  mediaToken = null;
  if (mediaTokenRefreshTimer) clearTimeout(mediaTokenRefreshTimer);
};

const tok = () => { ensureMediaToken(); return encodeURIComponent(mediaToken ?? ''); };
export const getStreamUrl   = (id: number | string) => `${API_BASE}/api/streaming/recordings/${id}/stream?token=${tok()}`;
export const getDownloadUrl = (id: number | string) => `${API_BASE}/api/streaming/recordings/${id}/download?token=${tok()}`;
export const getHlsUrl      = (cameraId: number | string) => `${API_BASE}/api/streaming/hls/${cameraId}/stream.m3u8?token=${tok()}`;

// ── Smart Search (CLIP-based natural-language search) ───────────────────────
export interface SmartSearchResult {
  detection_id: number;
  camera_id: number;
  camera_name: string | null;
  location: string | null;
  occurred_at: string;
  similarity: number;
  caption: string | null;
  thumbnail_url: string;
  clip_start: string;
  clip_end: string;
}
export interface SmartSearchResponse {
  query: string;
  interpreted: {
    time_range: { start: string; end: string };
    time_phrase: string | null;
    camera_id: number | null;
    description_used: string;
  };
  candidates_scanned: number;
  results: SmartSearchResult[];
}

export const smartSearch = (prompt: string, limit = 24) =>
  apiPost<SmartSearchResponse>('/api/search/smart', { prompt, limit });

// thumbnail_url from smartSearch() is a server-relative path that needs the
// same short-lived media token as other <img>/<video> src attributes.
export const getSmartSearchThumbnailUrl = (thumbnailUrl: string) =>
  `${API_BASE}${thumbnailUrl}?token=${tok()}`;

// Backward compat aliases
export const API_SERVER_URL = API_BASE;
export const getRecordingStreamUrl   = getStreamUrl;

// Snapshot JPEG attached to an AI-analytics event (fall / smoke / crowd / ...).
// Served by GET /api/analytics/snapshot/:eventId; same short-lived media token
// as the video/thumbnail URLs above.
export const getEventSnapshotUrl = (eventId: number | string) =>
  `${API_BASE}/api/analytics/snapshot/${eventId}?token=${tok()}`;
export const getRecordingDownloadUrl = getDownloadUrl;

// ── Time-range export ──────────────────────────────────────────────────────
// Unlike getDownloadUrl (a plain <a href> — fine for an instant single-file
// send), an export can take a few seconds to tens of seconds while the
// server concats/trims segments together, so this is a real fetch the
// caller can show a spinner around rather than a link that appears to do
// nothing until the browser's own download UI kicks in. Uses the normal
// login token (not the 5-min media token) since a large export can
// legitimately take longer than that to build.
export async function exportRecordingRange(
  cameraId: number,
  start: string,
  end: string,
): Promise<Blob> {
  const token = tokenStore.get();
  const params = new URLSearchParams({ camera_id: String(cameraId), start, end });
  const res = await fetch(`${API_BASE}/api/streaming/recordings/export?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Export failed (HTTP ${res.status})`);
  }
  return res.blob();
}
