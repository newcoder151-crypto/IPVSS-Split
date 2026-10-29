# What this update does   (copy the files over your folder, then:  bash start.sh)

1. mnvr_nishchal-main integrated (3-way merge with your M-NVR - nothing of either side lost)
   NEW  mnvr/backend/ai/analytics/**            analytics worker (fall / lean-out, smoke, crowd, track obstacle ...)
   NEW  mnvr/backend/api/src/routes/analytics.js, services/streamAutoDiscovery.js, create-service-user.js
   NEW  mnvr/database/migrations/006_camera_analytics.sql
   CHG  mnvr/backend/api/src/index.js, routes/cameras.js (kept: RTSP-address add; added: auto stream discovery),
        services/onvifClient.js, frontend/src/lib/api.ts, pages/EventsPage.tsx, backend/ai/README.md
   CHG  mnvr/scripts/start.sh   + creates the analytics worker's service account and its .env by itself
   The bridge understands the new events: PASSENGER_FALLEN / PASSENGER_LEANING_OUT / TRACK_OBSTACLE -> P9 alerts,
   SMOKE_DETECTED -> P8, CROWD_DENSITY -> P4; [SHADOW]-mode and AI_TEST events are never sent to CMS.
   (bridge/config/alert-rules.json, bridge/test/unit.js)

2. E-mail / forgot-password removed everywhere (M-NVR, CMS, RPF); every account is set to Admin@123
   start.sh does it for you once on the next start (and any time:  bash start.sh reset-passwords).
   The analytics worker's service account is not touched. No forced password change after that.
   RPF Team tab: add an officer with a starting password, or set a new password for a colleague.

start.sh also deletes the files of the removed feature (mailer, reset tokens, ResetPassword page, mail.env ...).

---
# Fix: M-NVR not starting + CMS database password (this update)

1. CMS role password is now always "cms" - start.sh writes it into the .env files and, if the PostgreSQL role has another
   password, runs ALTER ROLE for you (asks sudo once). Nothing to edit by hand any more. The .env.example files default to it too.
2. M-NVR database (role + db "mnvr") is created by the main start.sh in the foreground, where sudo can ask for the password.
   (Before, the M-NVR launcher ran in the background; "sudo" could not prompt and the setup silently did nothing.)
3. mnvr/scripts/start.sh
   - no longer dies on the first failing command (set -e removed; every step has its own check)
   - /storage not writable -> falls back to <project>/storage and keeps .env + all services in sync
   - the big AI downloads (torch etc.) now start AFTER the API and the web page, so M-NVR opens in ~1 minute instead of
     waiting for gigabytes of packages
   - stopping M-NVR no longer kills other "node src/index.js" processes (only this project's API)
   - random password for the analytics account made pipefail-safe; python3-venv problems are reported clearly
4. start.sh prints the real M-NVR state (and the last log lines when the API does not answer) instead of "Everything is running".

---
# Fix: "footage file is not reachable from the RPF server"

Cause found in the code: CMS stitches a delivered file into ITS MEDIA_ROOT and RPF reads from ITS MEDIA_ROOT. When an old copy
of the CMS (another folder, still running with its own background workers on the same database) delivers a request, the
database row says "delivered" but the file sits in that old copy's folder.

- start.sh: stops old CMS / RPF / bridge / M-NVR copies left running from other folders (copying their footage over first),
  pins ONE footage folder (<project>/media) for CMS and RPF, verifies after start-up that both really use it, and moves
  footage found in older folders into it. New commands: `bash start.sh check-footage`, `bash start.sh diagnose-footage`.
- RPF (services/storage.js): RPF now asks the RUNNING CMS where it stores footage (/health -> media_root) and looks there first,
  searches wider for moved files, and only accepts a file found by search when its SHA-256 matches the one recorded at delivery.
- CMS and RPF /health report media_root; the CMS logs its footage folder at start-up.

---
# Security: one post must never see another post's alerts, incidents or activity

Checked in the code and with the test-suite against a real database (12/12 pass; the new isolation test FAILS on the old code):
- CMS escalation no longer hands an unacknowledged alert to the next post (that was the only way two posts received the same
  alert). It is marked "escalated" for the control room instead. Old behaviour only with ESCALATE_TO_NEXT_POST=1.
- RPF alert history and incident timeline hide routing notes that name another post and everything another post's officers did.
- RPF incident detail lists only this post's own requests / evidence flags.
- A footage request can only be attached to the post's OWN incident (before, a foreign incident id was accepted and the request
  then appeared inside that other post's incident).
- The unauthenticated v0.1 CMS endpoints (/api/alerts, /api/incidents: every alert and incident of every post) are now OFF unless
  --demo is used (LEGACY_API=1 to turn them on deliberately).
- Registering another post on a dashboard that already serves one now needs the username + password of a current officer of that
  post (otherwise anyone who can reach the page could switch the dashboard).
- /health shows the footage folder and pid only to requests from the machine itself.

---
# RPF notices: pop-ups and tab counters

- Every notice CMS writes for the post (footage delivered, request approved / rejected / failed, evidence archived, incident, alert
  dismissed) now appears as a pop-up within a poll or live event; clicking it marks the notice read and opens the right screen.
  More than three at once collapse into "n more notices". On sign-in, unread notices are announced once.
- Counters on the tabs: Alerts (to acknowledge), Requests (open), Footage (delivered, not yet played or downloaded by anyone at the
  post - the list also marks them "new"), Evidence (unread CMS notices about flagged evidence; opening the tab clears it).
- Notices of other posts never appear (checked by test/ui_notices.test.js, which runs the real page against the real server and DB;
  it needs the optional `jsdom` package and skips itself without it).

---
# One dashboard for every post + merged M-NVR (mnvr_nishchal_2) + one command

1. RPF sign-in: officers of ANY post can sign in on the same dashboard ("this account belongs to a different post" is gone).
   Each officer sees only their own post - every query is filtered by the officer's own post (tests: 19/19, incl. post B signed
   in next to post A and getting 404 on A's alerts, incidents, footage, flags). Registering another post, once any officer
   exists, needs a current officer's username + password (a new post receives alerts, so it must not be open to anyone).
   Before sign-in the page shows no post names.
2. M-NVR: merged with mnvr_nishchal_2-main. Taken from it: the new analytics (smoke, crowd, rail-obstacle analyzers, shared
   geometry/persistence helpers, tracker `lap` fix, restart cool-off, README + 79 unit tests - all pass) and the TRACK_NOT_VISIBLE
   event. Kept from the project (the new zip was older there): CMS requests page, forced password change, RTSP probe /
   add-by-address, camera delete, ONVIF messages, account dialog, and the whole start.sh.
   Bridge: TRACK_NOT_VISIBLE becomes a low-priority "camera_blocked" notice (CROWD_DENSITY -> crowding was already mapped).
   The analyzers need their weights in backend/ai/analytics/models (smoke_detect.pt, seg_model.pt, detect_model.pt, yolo26m.pt,
   yolo26m-pose.pt); an analyzer without weights stays off and says so in logs/analytics.log.
3. `bash start.sh` starts everything (PostgreSQL role/databases, CMS, RPF, M-NVR + analytics, bridge). Tried end to end here: CMS,
   RPF, M-NVR API, web page (login through the proxy), bridge all answered. The M-NVR web page now falls back to IPv4 when the
   machine has IPv6 switched off (it used to fail with EAFNOSUPPORT and the page never came up).

---
# RPF tabs: Unacknowledged / Acknowledged alerts, Open / Closed incidents

- Alerts has two tabs with counters: Unacknowledged (opens here) and Acknowledged. Every alert is in exactly one of them; acknowledging
  moves it across at once (pop-up "Moved to Acknowledged alerts", click to jump there). Alerts CMS dismissed/resolved count as handled.
- Incidents has two tabs with counters: Open incidents (open + under review) and Closed incidents. Closing an incident moves it to Closed
  incidents (pop-up with a link). New API counters: alerts/summary -> acked, open_incidents, closed_incidents.
- Tested through the API and by clicking the real buttons in the page (test/ui_notices.test.js): 20/20 tests pass.

---
# RPF: notices, Incidents counter, and the alert / incident detail panels

- ROOT CAUSE of "notifications are just plain text": the dashboard is served with `style-src 'self'`, so the browser ignored the
  styles that app.js injected (<style> tag, style="" attributes). All styles now live in public/styles.css; app.js sets dynamic values
  through the CSSOM (allowed). test/csp_styles.test.js guards this. Checked with screenshots in a real Chromium (light + dark).
- Pop-ups: cards with a coloured icon, title, text, time, "click to open" and a timer bar; they sit left of an open detail panel.
  Bell panel: icon per notice type, unread dot, relative time, "Mark all read" visible, closes on outside click.
- Incidents tab has its own counter (open incidents); raising one shows "Incident #n raised" with its title. Raising an incident from
  an alert acknowledges the alert, so it leaves Unacknowledged and appears under Acknowledged (server already did this; now tested).
- Alert / incident detail panel redesigned: header with priority ring, status chips and a progress line (Received - Acknowledged -
  Incident - Footage - Closed), tabs Overview | Footage | Activity (the log is now only the Activity tab), fact cards, banners
  ("nobody has acknowledged this alert"), requests as cards, and a sticky action bar.
- Live pop-ups need `live.start()` (done by the normal server start-up); a page without the live stream refreshes every 20 s.

- Fix: the Footage tab of the new detail panels printed "[object HTMLDivElement],[object HTMLDivElement]" (a list of cards was handed to
  the browser as text). Tab bodies are now always mounted through h(), which flattens lists. Footage cards with Review / flag and
  Save to PC work again; test/ui_notices.test.js now opens a panel that has two delivered files and presses the viewer button.
