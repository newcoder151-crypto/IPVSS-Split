# Contributing

## Getting set up

```bash
bash scripts/start.sh --setup-db   # first time
bash scripts/start.sh              # thereafter
```

Work on one piece at a time with `--logs <svc>` open in a second terminal.

## Where code goes

| Change | Location |
|---|---|
| New screen / route | `frontend/src/pages/` + route in `App.tsx` + nav in `components/layout/AppHeader.tsx` |
| Reusable UI | `frontend/src/components/` (`ui/` holds shadcn primitives; add new ones with the shadcn CLI, `components.json` is configured) |
| New API endpoint | `backend/api/src/routes/<resource>.js`, mounted in `src/index.js`; add it to `docs/API.md` |
| External integration | `backend/api/src/services/` |
| Schema change | New file in `database/migrations/` **and** mirrored into `database/schema.sql`; update `docs/DATABASE.md` |
| AI model work | `backend/ai/sidecar.py` |
| Recording / live pipeline | `backend/stream-manager/stream_manager.py` |

## House rules

**Frontend**
- Import via `@/`; no `../../../` chains.
- Network calls go through `lib/api.ts` (or the hooks in `hooks/`); components don't build their own auth headers.
- Use `toApiDateTime()` for any timestamp sent to the API. Never `.toISOString()`.
- Don't leave unused components, hooks or dependencies behind; the build has none today.

**Backend**
- Parameterize every query (`$1`, `$2`). No string interpolation into SQL.
- `authenticate` for JSON routes; `authenticateMedia` for anything an `<img>` or `<video>` loads; `requireRole(...)` to restrict.
- Validate and re-check any path derived from user input before serving a file.
- Log detail server-side, return a generic message to the client.
- Don't add an endpoint nothing calls. If a worker or integration needs it, say so in `docs/API.md`.

**Migrations**
- Must be idempotent; `start.sh` re-applies all of them on every run.
- Comment *why* the change exists, not just what it does.

**Python**
- The AI services use `backend/ai/.venv`; the lighter workers use `backend/.venv`. Don't merge them.
- Launch via the venv's own interpreter (`.venv/bin/python -m uvicorn ...`), never a system-wide binary.

## Before opening a PR

```bash
cd frontend && npm test && npx tsc -p tsconfig.app.json --noEmit && npm run build
cd frontend && npm run lint      # reports pre-existing no-explicit-any errors (73 problems); don't add new ones
for f in $(find backend/api -name '*.js' -not -path '*/node_modules/*'); do node --check $f; done
python3 -m py_compile backend/ai/*.py backend/stream-manager/*.py backend/mediamtx/*.py
bash -n scripts/start.sh
```

Then run the stack once end to end and confirm `bash scripts/start.sh --status` is green.

## Commit messages

```
<area>: <what changed>

Why it was needed, and anything non-obvious about the approach.
```

Areas: `frontend`, `api`, `ai`, `stream-manager`, `db`, `scripts`, `docs`.
