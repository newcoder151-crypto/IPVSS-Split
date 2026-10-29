# Backend API

Node.js REST + WebSocket API. Handles authentication, validation, camera and
ONVIF control, recording playback/export and Smart Search. Full endpoint list:
[`docs/API.md`](../../docs/API.md).

**Stack:** Express · PostgreSQL (`pg`) · JWT (`jsonwebtoken`, `bcryptjs`) · `ws` · `helmet` · `express-rate-limit` · `onvif` · `axios`

## Running

```bash
npm install
npm run dev        # nodemon, http://localhost:3001
npm start          # production
node seed.js       # dev only: demo users + six cameras
```

Needs a `.env` (copy `.env.example`) and a database with `database/schema.sql`
applied. `bash ../../scripts/start.sh --setup-db` does all of that.

## Layout

```
src/
├── index.js        Entry point: security middleware, route mounting, static dirs, server start
├── db.js           Postgres pool + query/queryOne helpers
├── websocket.js    WebSocket server (/ws) and broadcast()
├── routes/         One file per resource, the entire HTTP surface
├── services/       onvifClient.js (ONVIF), rtspCheck.js (RTSP reachability)
├── middleware/
│   └── auth.js     authenticate (Bearer), authenticateMedia (?token=), requireRole
└── config/
    └── security.js Password policy, validators, production checks
```

## Routes

| Mount | File | Purpose |
|---|---|---|
| `/api/auth` | `auth.js` | Login, refresh, change password, media token, admin register |
| `/api/users` | `users.js` | User administration |
| `/api/cameras` | `cameras.js` | Camera CRUD and credentials |
| `/api/recordings` | `recordings.js` | Recording list |
| `/api/streaming` | `streaming.js` | Stream/download, HLS, time-range export (ffmpeg) |
| `/api/events` | `events.js` | Events and alarms (list, ingest, acknowledge) |
| `/api/search/smart` | `smart-search.js` | CLIP natural-language search |
| `/api/ai` | `ai.js` | `index-detection` ingest used by the indexer |
| `/api/onvif` | `onvif.js` | Discovery, PTZ, imaging, audio, profiles |
| `/api/mediamtx` | `mediamtx.js` | Playable URLs and MediaMTX status |
| `/api/system` | `system.js` | Host info, reboot, shutdown |
| `/api/settings`, `/api/config` | `settings.js`, `config.js` | Runtime configuration and status |

## Conventions

- **Auth.** `authenticate` for JSON endpoints; `authenticateMedia` for anything an
  `<img>`/`<video>` loads (accepts a short-lived `?token=` too);
  `requireRole('ADMIN', …)` to restrict.
- **Queries are always parameterized** (`$1`, `$2`). Where a `LIMIT` is built
  dynamically it is a validated integer.
- **Timestamps are timezone-naive.** Never `.toISOString()` when building a
  query window; see the comment at the top of `routes/smart-search.js`.
- **File paths from outside are untrusted.** Anything resolved under
  `STORAGE_PATH` is re-checked to sit inside the intended directory.
- **Errors:** log detail server-side, return a generic message.
