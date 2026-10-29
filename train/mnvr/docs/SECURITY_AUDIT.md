# mNVR API Server — OWASP Top 10 Security Hardening

> **Status note (clean-up):** this audit was done before the clean-up in
> [CLEANUP.md](CLEANUP.md). The C daemon (`core/`), `routes/search.js`,
> `routes/nvr.js` and the Swagger UI it mentions have since been removed, so
> those items no longer apply; every other finding stands.

**Scope of this pass:** the Node.js/Express API server (`backend/api/`) — the network-facing
attack surface handling authentication, camera control, recordings, and the AI pipeline.
**Not covered in this pass:** the React frontend (`frontend/src/`), the C `mnvrd` daemon
(`core/`), and the Python YOLO sidecar. See "Out of scope" at the bottom for what
each of those would need.

Every fix below was written against the actual code in this repo (not generic advice),
and the full flow — login, forced password change, role-based access control, path
traversal, CORS, and production fail-fast checks — was verified end-to-end against a
live PostgreSQL instance loaded with `schema.sql`, not just read through statically.
That live test caught three real bugs (two pre-existing, one introduced during the
fix) that a static review would have missed — see "Bugs found via testing" below.

---

## A01 — Broken Access Control

| Issue | File | Fix |
|---|---|---|
| `POST /api/auth/register` was open to **any unauthenticated caller** — anyone could create an account on the API. | `routes/auth.js` | Locked to `ADMIN` role. The only supported account-creation path is now `POST /api/users` (ADMIN-only) or this admin-authenticated endpoint for scripted provisioning. |
| HLS segment route only checked the file **extension**, not the path — `../../../etc/passwd.ts`-style traversal could escape the storage directory. | `routes/streaming.js` | Strict allow-list regex on filenames (no separators, no `..`) **plus** real-path containment check (`fs.realpathSync` + prefix match) so symlinks can't be used to escape either. |
| Debug endpoint `/streaming/list` dumped the entire recordings filesystem tree to any authenticated user, including VIEWER. | `routes/streaming.js` | Restricted to `ADMIN`. |
| Event acknowledgment (`/events/all/acknowledge`, `/batch/acknowledge`, `/:id/acknowledge`) and event/recording creation had **no role check** — a VIEWER-level token (or a leaked viewer token) could silence every alarm in the system. | `routes/events.js`, `routes/recordings.js` | Restricted to `ADMIN`/`OPERATOR`. |
| Camera health-telemetry endpoint could be written to by any authenticated role. | `routes/cameras.js` | Restricted `POST /:id/health` to `ADMIN`/`OPERATOR`. |
| Swagger docs (`/api/docs`) exposed the entire API surface — every route, param, and schema — unauthenticated. | `index.js` | Gated behind `ADMIN` auth when `NODE_ENV=production`; still open in dev for convenience. |

## A02 — Cryptographic Failures / Sensitive Data Exposure

| Issue | File | Fix |
|---|---|---|
| Hardcoded fallback JWT secret (`'railway-nvr-secret-change-in-production'`) used silently if `JWT_SECRET` was unset. | `middleware/auth.js` | Centralized into `config/security.js`, which **refuses to start** in production without an explicit `JWT_SECRET` (min 32 chars). |
| `websocket.js` had a **different** hardcoded fallback secret than the API (`'change-me-in-production'` vs `'railway-nvr-secret-change-in-production'`) — if `JWT_SECRET` were ever unset, WebSocket auth would silently fail against API-issued tokens. | `websocket.js` | Now imports the same `JWT_SECRET` from `config/security.js`. One secret, one source of truth. |
| `cameras.js` used `SELECT c.*`, which returned the camera's **RTSP credentials** (`password_hash`, `rtsp_url`) to every authenticated user regardless of role. | `routes/cameras.js` | Rewrote to an explicit, credential-free column list (`CAMERA_PUBLIC_COLUMNS`) used everywhere a camera is serialized. |
| `mediamtx.js` `/cameras` endpoint also leaked `rtsp_url` (which embeds credentials) to the browser. | `routes/mediamtx.js` | Removed — client only needs the WebRTC/HLS URLs, which carry no credential. |
| DB connection had a hardcoded default password fallback. | `db.js` | Same fail-fast pattern as `JWT_SECRET`; production requires `DB_PASSWORD` explicitly. Added optional `DB_SSL` support. |
| `start.sh` (the launcher script) writes a **hardcoded** JWT secret (`railway-nvr-super-secret-change-in-production`) into every freshly created `backend/api/.env`. | `scripts/start.sh` | **Not actually fixed in this repo, on either side of the restructure** — checked both `scripts/start.sh` here and the original `start.sh`; both still write the literal placeholder verbatim with no `openssl rand`/random-generation or replace-on-detection logic anywhere in the file. `config/security.js` at least refuses to run in production without a real `JWT_SECRET` (see the fallback fix above), so the exposure is bare-metal dev/first-run only, not production — but the fix this row describes doesn't exist. Treat it as still open: generate one manually (`openssl rand -hex 32`) and set it in `backend/api/.env` before anything beyond local dev. |
| Default admin credential (`Admin@123`) is committed in plaintext-adjacent form (bcrypt hash) to a **public git repository** — anyone reading the repo knows the starting password. | `schema.sql` | Can't fully eliminate this without changing your setup flow, so it's mitigated instead: `must_change_password=1` is now **actually enforced** (see A07) — the account can log in exactly once and is blocked from everything else until the password is rotated. Documented the residual risk directly in `schema.sql`; recommend a randomly generated one-time password at provisioning time for a real deployment. |

## A03 — Injection

Your existing SQL usage was already consistently parameterized (`$1, $2...`), including
the dynamic-column `UPDATE` builders in `cameras.js`/`recordings.js`, which build column
names from a **fixed server-side whitelist**, not user input — no injection found there.
The `search.js` free-text parser maps keywords to a fixed dictionary of enum values, never
raw user text, into SQL — also safe. Main remaining "injection-adjacent" issue was the
path traversal above (filed under A01, since that's how OWASP categorizes it in practice).

Fixed: `ai.js`'s `model` parameter was forwarded **unchecked** to the Python YOLO
sidecar's `YOLO(name)` loader, which treats that string as either a hub model name or a
local file path — attacker-controlled input here could make the sidecar load an
arbitrary local path or trigger unbounded downloads. Pinned to a curated whitelist of
known model names.

## A04 — Insecure Design

| Issue | Fix |
|---|---|
| No pagination limits on `/cameras`, `/events`, `/recordings` — a `?limit=999999999` could force a huge query. | Clamped to a max of 500 per page across all three. |
| WebSocket had no message-size cap — a single client could send oversized frames. | Capped at 16 KB per inbound WS message. |
| No password strength policy anywhere. | Minimum 10 characters, common-password rejection, enforced on register/create/change-password. |
| `must_change_password` flag existed in the schema but was **never checked anywhere** — a no-op. | Now enforced in `authenticate` middleware: any account flagged this way is blocked from every route except the ones needed to actually change the password. |

## A05 — Security Misconfiguration

| Issue | Fix |
|---|---|
| `CORS_ORIGIN` defaulted to `*` combined with `credentials: true` — invalid and dangerous if it worked. | Explicit origin allow-list, **required** in production (server refuses to start without it). |
| Every route handler returned raw `err.message` to the client — leaks table/column names, constraint violations, SQL fragments. | Generic client-facing message everywhere; full detail logged server-side only (`console.error`). |
| No CSP, weak default headers. | Added Content-Security-Policy, HSTS, `referrer-policy: no-referrer` via `helmet`. |
| No global rate limiting (only relied on the auth-route limiter). | Added a 300 req/min per-IP limiter across all of `/api`. |
| `trust proxy` wasn't configured — `req.ip` (used for rate limiting) could be spoofed via `X-Forwarded-For` if the app sat behind a reverse proxy, or would be wrong without one. | Set `trust proxy` to exactly 1 hop by default, configurable via `TRUST_PROXY_HOPS`. |

## A06 — Vulnerable and Outdated Components

`multer@1.4.5-lts.1` has known, npm-flagged CVEs (confirmed via `npm install` deprecation
warning). Upgraded to `multer@2.x` and verified your exact usage pattern
(`memoryStorage`, `.single()`, `limits`, `fileFilter`) is drop-in compatible — tested
live with a real upload-handling route.

**Not yet done:** a full `npm audit` sweep of the frontend's dependency tree, and no
attempt was made to upgrade `onvif`, `pg`, `express`, or other majors — those weren't
flagged as vulnerable but weren't deeply audited either.

## A07 — Identification & Authentication Failures

| Issue | Fix |
|---|---|
| JWT accepted via query string (`?token=...`) as well as the `Authorization` header — query-string tokens leak into access logs, proxy logs, and `Referer` headers. | Header-only now, both for the REST API and WebSocket upgrade. |
| Login response timing/branching could reveal whether a username exists. | `bcrypt.compare` now always runs (against a dummy hash for non-existent users), and both "no such user" and "wrong password" return the identical `{"error":"Invalid credentials"}`. |
| No brute-force protection beyond the existing lockout-after-5-failures logic. | Added a 10-attempts/15-min rate limiter on `/login` and `/register`, keyed by IP+username. |
| JWT had no pinned algorithm or issuer check (algorithm-confusion risk). | `jwt.verify` now pins `algorithms: ['HS256']` and checks `issuer`. |

## A08 — Software and Data Integrity Failures

`ai.js` accepted file uploads with **no MIME-type restriction** — any file type up to
25MB was forwarded to the Python sidecar. Added an allow-list (`image/jpeg`, `png`,
`webp`, `bmp`) enforced via multer's `fileFilter`, with clean 400 responses on rejection
instead of the upload silently reaching the sidecar.

## A09 — Security Logging and Monitoring Failures

Failed logins were already tracked in the DB (pre-existing, good). Added: consistent
server-side `console.error` logging on every route's catch block (previously many just
returned the error to the client and logged nothing), and login now records the
client IP (`last_login_ip`) on success.

**Not done:** a proper structured audit log for admin actions (user creation/deletion,
role changes, camera credential rotation) — your schema already has an `audit_log`
table that nothing currently writes to. That's a good next increment; wiring every
ADMIN-role mutation to write an audit row is mechanical but touches every route file
again, and was out of budget for this pass.

## A10 — Server-Side Request Forgery (SSRF)

Reviewed `onvif.js`/`onvifClient.js` and `mediamtx.js` for user-controlled URLs. Camera
IP addresses only ever come from the database (written by an ADMIN through the camera
CRUD endpoints), never directly from a request parameter — so there's no single-request
SSRF injection point. The residual risk is inherent to the feature: an ADMIN account
(or a compromised one) could point a "camera" at an internal service and trigger the
app's ONVIF/RTSP client against it. That's a legitimate design tradeoff for a camera
management system, not a bug — but if you want defense in depth, consider restricting
camera `ip_address` values to your known camera VLAN/subnet at the application layer or
via network segmentation, rather than accepting any address.

---

## Bugs found via live testing (not just static review)

Because I actually ran this against a live PostgreSQL instance with your schema:

1. **Role list mismatch** — the DB's `chk_user_role` constraint allows `ADMIN, OPERATOR,
   MAINTENANCE, VIEWER, API_CLIENT`, but my first-pass validation only recognized 3 of
   the 5. Would have silently locked out MAINTENANCE/API_CLIENT accounts. Fixed by
   exporting one `VALID_ROLES` list from `config/security.js` that every file imports.
2. **Broken seed password hash** (pre-existing, not introduced by this pass) — the
   bcrypt hash shipped in `schema.sql` for the documented default admin password
   (`Admin@123`) didn't actually match that password. Regenerated a correct hash.
3. **Column name bug** (introduced while writing the credential-safe column list) —
   referenced `c.created_at`, which doesn't exist on `cameras` (the actual column is
   `added_at`). Caught via a live 500 error and fixed immediately.

Verified end-to-end: login → forced-password-change block → change-password →
re-login → camera list access; VIEWER correctly denied `POST /cameras` and
`GET /users` (403) but retains read access; path-traversal payloads on the HLS route
return 400 instead of file contents; CORS rejects a disallowed `Origin`; production
mode refuses to boot without `JWT_SECRET`/`CORS_ORIGIN` and gates Swagger behind auth.

---

## Required action before deploying this

Set these in `backend/api/.env` (see `backend/api/.env.example`):

```
JWT_SECRET=<openssl rand -hex 32>
DB_PASSWORD=<your real DB password>
CORS_ORIGIN=https://your-frontend-domain.example   # comma-separated if multiple
NODE_ENV=production
```

The server will now **refuse to start** in production without these — that's
intentional, not a bug.

---

## Out of scope for this pass

- **React frontend (`src/`)**: no review of XSS handling, token storage (localStorage
  vs memory), or client-side route guards.
- **C daemon (`core/`)**: no review of the `mnvrd` binary, buffer handling, or IPC
  with the Node API — C is a different risk class (memory safety) than the OWASP Top
  10, which is primarily a web-app framework.
- **Python YOLO sidecar**: no review of `sidecar.py` itself, only of what the Node API
  forwards to it.
- **Dependency audit**: `npm audit` wasn't run against the frontend's `package.json`.

Each of those is a legitimate follow-up if you want it — happy to do any of them next.
