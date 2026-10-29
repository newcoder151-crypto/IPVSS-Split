# Clean-up notes

This release removes everything the running system does not use, **without
changing the UI or any behaviour the UI depends on**. The remaining
`frontend/src` files are byte-identical to the previous version (files were only
deleted, none edited). The clean API was compared against the previous API on a
real PostgreSQL with the same requests: all 52 regular requests (everything the UI
calls, plus auth failures and role checks) returned identical status codes and
response shapes.

## Removed

### Dead services and code
| Item | Why |
|---|---|
| `core/` (C daemon `mnvrd`, ~14.7k lines, Makefile, systemd unit docs) | Disabled in `start.sh` (`if false`); nothing in the stack talked to it |
| `backend/recorder/` (Python recorder) | Disabled in `start.sh`; `stream-manager` records and registers segments itself |
| `.pids/` | Runtime PID files that were included in the archive (`start.sh` recreates the directory) |
| `docs/INTEGRATION.md`, `docs/CHANGELOG.md`, `docs/REFERENCE.md` | Described the removed daemon / a past merge; replaced by `docs/API.md` and `docs/DATABASE.md` |
| Swagger UI (`src/swagger.js`, `/api/docs`, `swagger-ui-express`) | Hand-written, covered only part of the API and listed endpoints that no longer exist; `docs/API.md` replaces it |
| `startNvrHealthPush`, `sendToUser`, `broadcastToCamera` in `websocket.js` | Never called; the first polled the removed daemon |

### API endpoints (none called by the UI or any worker)
| Removed | Notes |
|---|---|
| Entire `/api/nvr/*` (status, reload, config, discover) | Proxied to the removed daemon |
| Entire `/api/search` (free-text `POST /`, `GET /suggestions`) | The Search page uses `/api/search/smart` |
| `/api/ai/*` proxy routes (detect, people-count, intrusion, object-detect, analytics, models, health) | Router was never mounted. Only `index-detection` was kept, see *Fixed* |
| `GET /api/events/:id` | List already returns every field. **`POST /api/events` was kept** as the integration ingress |
| `GET`/`POST /api/cameras/:id/health` | stream-manager writes `camera_health` directly; the UI reads health via `GET /api/cameras` |
| `GET /api/recordings/:id`, `POST`, `PUT`, `DELETE /api/recordings` | Only the removed Python recorder used them |
| `GET /api/mediamtx/streams`, `POST /api/mediamtx/sync` | mediamtx-sync talks to MediaMTX directly |
| `GET /api/streaming/udp/:cameraId/info`, `GET /api/streaming/list` | Unused |
| `GET /api/onvif/cameras/:id/profiles/:token/stream-uri` | Unused |
| `GET /api/settings/cameras/:slot` | The list endpoint returns the same data |
| `GET /api/users/:id` | List endpoint covers it |

**Kept although the UI never calls them:** `POST /api/auth/refresh` and
`POST /api/auth/change-password` (the only way past the forced password change,
see below), `POST /api/events` (events enter the system here), and
`POST /api/auth/register` (the `/register` page calls it).

### Frontend (nothing imported them)
- Components: `CameraTile.tsx`, `CameraZoomDialog.tsx`; `lib/api-server.ts`;
  `hooks/use-mobile.tsx`; `components/ui/use-toast.ts` (duplicate of `hooks/use-toast`); `App.css`
- 26 unused shadcn/ui primitives (accordion, carousel, chart, form, sidebar, table, …)
- Playwright config/fixture (it imported a package that isn't installed) and the placeholder `example.test.ts`
- 21 npm dependencies (recharts, zod, react-hook-form, embla-carousel-react, cmdk, vaul, input-otp, react-resizable-panels, 12 unused Radix packages, …) and three dev dependencies; Vite's pre-bundle list updated to match

### API dependencies
`swagger-ui-express`, `multer`, `form-data` (no remaining code imports them).

### Database (`schema.sql`: 2,663 → 911 lines)
45 tables that no retained code reads or writes, 8 views, and the triggers on
them: RDSO-style feature tables (face recognition, panic button, HHT, ETBU,
RDAS, geofences, maintenance, backup, audit and session tables, and similar).
Verified by building the pruned schema and comparing every column, index,
constraint, trigger and function with the original schema minus exactly those
objects (identical). All five migrations apply cleanly and the file is safe to
re-run. `microphones` stays because `recordings.audio_stream_id` references it.
The complete original schema is in the previous version of the repository.

### Launcher
`scripts/start.sh` no longer builds or starts the C daemon or recorder
(`--build-nvr`, `--with-nvr` removed); steps renumbered 1–9.

## Fixed (one behavioural change)

**Smart Search could never populate.** `backend/ai/indexer.py` POSTs every
detected person to `/api/ai/index-detection`, but `routes/ai.js` was never
mounted, so every post returned 404 and `person_detections` stayed empty. The
router is now trimmed to that one endpoint and mounted. Verified: 404 → 201
with a row written.

## Findings (not changed, because they would alter the UI or deployment)

1. **Forced password change has no UI.** Fresh installs flag `admin` with
   `must_change_password`; the API then 403s everything else and the frontend
   has no screen for it. Workaround in [QUICK_START](QUICK_START.md#first-login).
2. **`/register` cannot work from the UI**: the endpoint is ADMIN-only but the
   page is reachable signed-out.
3. **`start.sh` hard-codes `admin` / `Admin@123`** for the indexer's API login,
   and its generated `.env` uses a fixed default `JWT_SECRET`. Replace both
   before any real deployment.
4. **`gps_track_log`, `system_health`, `storage_devices` have readers but no
   writer** now that the C daemon is gone (it was already disabled), so GPS
   overlay, health cards and the storage summary are empty until something
   feeds them. Unchanged from before.
5. `npm run lint` reports 73 pre-existing problems (mostly `no-explicit-any`);
   it was 79 before the dead files were removed. Not fixed to avoid touching UI code.

## Verification performed

| Check | Result |
|---|---|
| Frontend `tsc`, `vite build`, `vitest` | pass |
| Remaining `frontend/src` files vs previous | 0 modified (deletions only) |
| API, same 69 requests on previous and clean builds (real PostgreSQL, fresh seeded DB each) | 52 / 52 regular requests identical; the 11 removed endpoints that previously answered now 404; `index-detection` 404 → 201 |
| Clean schema + 5 migrations on empty DB; re-run | OK, idempotent; object inventory identical to expected |
| Node `--check`, Python `py_compile`, `bash -n start.sh` | pass |
| **Not run:** the full stack with real cameras, MediaMTX, ffmpeg and the AI models | needs your hardware; run `bash scripts/start.sh --status` after starting |
