// node scripts/check_db.js - verifies the shared CMS database is usable by RPF. Read-only.
const { checkSchema } = require('../src/services/schemaCheck');
const { pool } = require('../src/db');

(async () => {
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, current_user AS usr');
    console.log(`connected to database '${rows[0].db}' as '${rows[0].usr}'`);
    const { missing, lacking } = await checkSchema();
    if (missing.length) {
      console.error('FAIL - CMS schema items RPF needs are missing:\n  - ' + missing.join('\n  - '));
      process.exitCode = 1;
    } else {
      console.log('OK   - all tables/columns RPF uses are present');
    }
    if (lacking.length) {
      console.warn('WARN - this role lacks:\n  - ' + lacking.join('\n  - '));
      console.warn('       (run sql/rpf_app_role.sql as the database owner, or connect as the CMS owner role)');
    } else if (!missing.length) {
      console.log('OK   - all privileges RPF needs are granted');
    }
  } catch (err) {
    console.error('FAIL -', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
