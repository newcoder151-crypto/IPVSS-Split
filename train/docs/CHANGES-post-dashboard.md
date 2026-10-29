# RPF = one post, with first-run registration  (copy over the same paths, then: bash start.sh restart)

DELETE this file (the admin API no longer exists):
  RPF_CMS/rpf/src/routes/admin.js

NEW:      RPF_CMS/rpf/src/routes/setup.js (registration), routes/audit.js (post activity log), services/binding.js
CHANGED:  RPF_CMS/rpf/src: config.js, server.js, middleware/auth.js, services/{scope,live,audit}.js,
          routes/{auth,alerts,incidents,requests,footage,flags,media,meta,notifications}.js
          RPF_CMS/rpf/public/{app.js,styles.css}   RPF_CMS/rpf/scripts/{manage_users.js,seed_demo.js,start.sh}
          RPF_CMS/rpf/sql/rpf_app_role.sql  RPF_CMS/rpf/.env.example  RPF_CMS/rpf/README.md  RPF_CMS/rpf/test/workflow.test.js
          start.sh  docs/INTEGRATION.md

Existing install: it has no post bound yet, so it opens on the registration form. To keep using an existing post instead:
  bash RPF_CMS/rpf/scripts/start.sh users bind "<post name>"
