# M-NVR camera fixes + CMS migration fix   (copy over the same paths)

CMS  RPF_CMS/CMS/sql/migrations/002_workflow.sql
     Fixes "check constraint chk_flag_archive_status ... is violated by some row" on start: migration 004 allows
     'not_requested' (locally kept evidence) but 002, re-run on every start, re-added a rule without it.

M-NVR backend (restart the API)
     mnvr/backend/api/src/routes/cameras.js     POST /api/cameras/probe-rtsp (new); create accepts a full RTSP URL
     mnvr/backend/api/src/routes/settings.js    deleting a camera in Settings now removes the camera itself too
     mnvr/backend/api/src/routes/onvif.js       clear message when a camera itself needs its factory password changed
     mnvr/backend/api/src/routes/auth.js        /me reports must_change_password
     mnvr/backend/api/src/services/rtspCheck.js splitRtspUrl(); probe also reports codec / resolution / audio

M-NVR frontend (rebuild: cd mnvr/frontend && npm run build, or restart the dev server)
     NEW  src/components/ChangePasswordGate.tsx
     NEW  src/components/camera/DiscoverCameraDialog.tsx   (shared; Scan network + RTSP address)
          src/lib/api.ts, contexts/AuthContext.tsx, components/ProtectedRoute.tsx
          src/hooks/use-cameras.ts, pages/CameraGrid.tsx, pages/SettingsPage.tsx
