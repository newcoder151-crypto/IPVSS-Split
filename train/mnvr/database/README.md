# Database

PostgreSQL schema for the mNVR platform.

| Path | Purpose |
|---|---|
| `schema.sql` | Complete schema — the source of truth for a **fresh** install |
| `migrations/` | Numbered, idempotent changes applied to **existing** databases |

## How it's applied

`scripts/start.sh --setup-db` creates the database and applies `schema.sql`.

Every subsequent `start.sh` run re-applies **all** files in `migrations/`, in
filename order. This is why every migration must be idempotent — it will run
many times over the life of a deployment.

## Adding a migration

1. Create `migrations/00N_short_description.sql` (next free number).
2. Write it so re-running is harmless:
   ```sql
   CREATE TABLE IF NOT EXISTS ...
   ALTER TABLE x ADD COLUMN IF NOT EXISTS ...
   ALTER TABLE x DROP CONSTRAINT IF EXISTS chk_y;
   ALTER TABLE x ADD CONSTRAINT chk_y CHECK (...);
   CREATE INDEX IF NOT EXISTS ...
   ```
3. **Mirror the same change into `schema.sql`**, so fresh installs get it
   without replaying history.
4. Add a comment block at the top explaining *why* — the schema outlives
   everyone's memory of the ticket.

## Current migrations

| File | Adds |
|---|---|
| `001_onvif_profile_s.sql` | ONVIF Profile S capability columns |
| `002_ai_model_config.sql` | AI model configuration |
| `003_third_rtsp_url.sql` | Third RTSP URL per camera |
| `004_log_retention.sql` | `recording_settings.log_retention_days` |
| `005_person_search_index.sql` | `person_detections` — backs Smart Search |

## Notes

- **Timestamps are timezone-naive** (`TIMESTAMP`, not `TIMESTAMPTZ`) and are
  compared against naive local wall-clock strings from the application layer.
  Converting to UTC anywhere in the stack shifts every time-window query by the
  local offset. Both `frontend/src/lib/utils.ts` and
  `backend/api/src/routes/smart-search.js` carry comments about this.
- **`person_detections.embedding`** stores a CLIP vector as a JSON array of
  floats rather than a `pgvector` column, so the platform runs on a stock
  PostgreSQL install with no extensions. Candidate rows are always narrowed by
  time/camera first, so the similarity pass only runs over a bounded window.
- **Retention:** nothing prunes `person_detections` rows or their thumbnails
  automatically yet. Pair it with the job that already prunes old recordings so
  the index doesn't outlive the footage it points at.
