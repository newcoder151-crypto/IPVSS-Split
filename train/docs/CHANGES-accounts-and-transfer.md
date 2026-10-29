# Accounts (RPF / mNVR / CMS) + fault-tolerant footage transfer   (copy over the same paths)

RPF   NEW   rpf/src/services/security.js (join code + recovery codes), rpf/src/routes/team.js
      CHG   rpf/src/routes/{auth,setup}.js, rpf/src/server.js, rpf/public/{app.js,styles.css}, rpf/sql/rpf_app_role.sql,
            rpf/test/workflow.test.js     (re-run rpf_app_role.sql if you use the restricted DB role)
mNVR  NEW   backend/api/src/services/recovery.js, backend/api/scripts/reset_password.js,
            frontend/src/components/{RecoveryCodeBox,AccountSecurityDialog}.tsx
      CHG   backend/api/src/routes/auth.js, frontend/src/{contexts/AuthContext.tsx,pages/Login.tsx,pages/CmsRequestsPage.tsx,
            hooks/use-cms-requests.ts,components/ChangePasswordGate.tsx,components/layout/AppHeader.tsx}
CMS   NEW   backend/src/services/recovery.js
      CHG   backend/src/routes/console/auth.js, backend/public/{index.html,console.css,js/boot.js},
            backend/src/services/{segmentService,requestService}.js, backend/src/routes/nvr.js   (transfer integrity checks)
Bridge NEW  src/resilient.js, test/fault.js
      CHG   src/{uploader,commands,cmsClient,config,transfers}.js, test/e2e.js, .env.example
