const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validatePasswordStrength, validateEmail, validateUsername, VALID_ROLES } = require('../config/security');

const router = express.Router();

const ALLOWED_ROLES = VALID_ROLES;
const PARAM_ID = /^\d+$/;

function isValidId(id) {
  return PARAM_ID.test(String(id));
}

// GET /api/users
router.get('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const rows = await query(
      `SELECT user_id, username, full_name, email, phone, role, is_active, is_locked,
              failed_login_attempts, created_at, last_login_at, created_by
       FROM users ORDER BY created_at DESC`);
    res.json({ users: rows.rows, total: rows.rowCount });
  } catch (err) {
    console.error('[users:list]', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// POST /api/users — the only supported way to provision an account
// (OWASP A01: no public self-registration path exists — see routes/auth.js).
router.post('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { username, password, full_name, email, phone, role = 'VIEWER' } = req.body;
    if (!username || !password || !full_name) {
      return res.status(400).json({ error: 'username, password, full_name required' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'username must be 3-32 characters: letters, numbers, dot, underscore, hyphen' });
    }
    if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (!ALLOWED_ROLES.includes(String(role).toUpperCase())) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }

    if (await queryOne('SELECT user_id FROM users WHERE username=$1', [username])) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await queryOne(
      `INSERT INTO users(username, password_hash, full_name, email, phone, role, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING user_id, username, full_name, email, phone, role, created_at`,
      [username, hash, full_name, email || null, phone || null, role.toUpperCase(), req.user.username]);
    res.status(201).json(user);
  } catch (err) {
    console.error('[users:create]', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id
router.put('/:id', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const { full_name, email, phone, role, is_active, is_locked } = req.body;

    if (email !== undefined && !validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (role !== undefined && role !== null && !ALLOWED_ROLES.includes(String(role).toUpperCase())) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }
    // Prevent an admin from locking themselves out or demoting the last admin
    // by accident isn't fully enforceable at this layer, but at minimum
    // block self-lockout via this endpoint.
    if (parseInt(req.params.id) === req.user.sub && (is_active === 0 || is_active === false || is_locked === 1 || is_locked === true)) {
      return res.status(400).json({ error: 'Cannot deactivate or lock your own account' });
    }

    const user = await queryOne(
      `UPDATE users SET
         full_name=COALESCE($1, full_name), email=COALESCE($2, email),
         phone=COALESCE($3, phone), role=COALESCE($4, role),
         is_active=COALESCE($5, is_active), is_locked=COALESCE($6, is_locked),
         updated_at=NOW()
       WHERE user_id=$7
       RETURNING user_id, username, full_name, email, phone, role, is_active, is_locked`,
      [full_name || null, email || null, phone || null, role ? role.toUpperCase() : null,
       is_active !== undefined ? is_active : null, is_locked !== undefined ? is_locked : null, req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('[users:update]', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// PUT /api/users/:id/password
router.put('/:id/password', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const { password } = req.body;
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ error: pwError });
    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash=$1, must_change_password=0, updated_at=NOW() WHERE user_id=$2', [hash, req.params.id]);
    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('[users:password]', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// DELETE /api/users/:id (soft-delete — deactivate)
router.delete('/:id', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    if (parseInt(req.params.id) === req.user.sub) return res.status(400).json({ error: 'Cannot delete yourself' });
    await query('UPDATE users SET is_active=0, updated_at=NOW() WHERE user_id=$1', [req.params.id]);
    res.json({ message: 'User deactivated' });
  } catch (err) {
    console.error('[users:delete]', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;
