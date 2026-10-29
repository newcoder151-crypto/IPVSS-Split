# Changed files (copy over the same paths, then `bash start.sh restart`)

RPF  (fixes "footage file is not reachable from the RPF server")
  RPF_CMS/rpf/src/config.js            also looks in MEDIA_ROOT_EXTRA and <CMS>/media
  RPF_CMS/rpf/src/services/storage.js  tries every known footage folder (path-escape protection kept)

M-NVR  (new "CMS Requests" page with live transfer %)
  mnvr/backend/api/src/routes/cms-requests.js            NEW  relays progress from the bridge
  mnvr/backend/api/src/index.js                          +1 line (mounts /api/cms-requests)
  mnvr/frontend/src/hooks/use-cms-requests.ts            NEW
  mnvr/frontend/src/pages/CmsRequestsPage.tsx            NEW
  mnvr/frontend/src/App.tsx                              +route /cms-requests
  mnvr/frontend/src/components/layout/AppHeader.tsx      +nav item "CMS Requests"

Bridge  (progress tracking)
  bridge/src/transfers.js NEW, uploader.js, commands.js, cameraMap.js, alerts.js, status.js
  bridge/test/e2e.js      (adds a progress check; 35/35 pass)
