# Frontend — mNVR Operator Console

React + TypeScript single-page app: live camera viewing, recording playback,
smart search, event handling, and system administration.

**Stack:** React 18 · Vite · TypeScript · Tailwind CSS · shadcn/ui · React Query ·
React Router · hls.js

## Running

```bash
npm install
npm run dev        # http://localhost:8080
```

Vite proxies `/api` and `/ws` to `http://localhost:3001`, so the API must be
running for anything beyond the login screen to work. The whole stack at once:
`bash ../scripts/start.sh`.

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with HMR on :8080 |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | ESLint |

## Layout

```
src/
├── pages/         One file per route — Dashboard, SearchPage, Playback, Settings…
├── components/
│   ├── ui/        shadcn/ui primitives (button, dialog, select…) — generated, rarely edited by hand
│   ├── layout/    App chrome: AppHeader (navigation lives here), AppLayout
│   ├── camera/    Camera-specific widgets (player, tiles, PTZ controls)
│   └── notifications/
├── hooks/         Data-fetching hooks wrapping React Query (use-cameras, use-recordings…)
├── contexts/      Auth provider and other global state
├── lib/
│   ├── api.ts     Every API call and URL helper — the single network boundary
│   └── utils.ts   Shared helpers (date formatting, pagination math)
└── test/          Test setup and fixtures
```

## Conventions

- **`@/` resolves to `src/`** — import as `@/components/ui/button`, never deep relative paths.
- **All network calls go through `lib/api.ts`.** Components never call `fetch`
  directly; this keeps auth headers, media tokens, and base URLs in one place.
- **Media URLs need a token.** `<img>` and `<video>` can't send an
  `Authorization` header, so thumbnails/streams use short-lived `?token=`
  URLs from the `get*Url()` helpers in `lib/api.ts`.
- **Timestamps are naive local wall-clock strings**, not UTC ISO. See the
  comment on `toApiDateTime()` in `lib/utils.ts` — the database stores
  timezone-naive values, and converting to UTC here silently shifts every
  search window. Use that helper rather than `.toISOString()`.
- **New screen?** Add the page under `pages/`, register the route in
  `App.tsx`, and add a nav entry in `components/layout/AppHeader.tsx`.
