const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db');
const { generateToken, generateMediaToken, authenticate, requireRole, authLimiter } = require('../middleware/auth');
const { validatePasswordStrength, validateEmail, validateUsername, VALID_ROLES } = require('../config/security');


const router = express.Router();

// A generic, timing-insensitive-enough failure message for both "user does
// not exist" and "wrong password" — do not let /login reveal which one it
// was (OWASP A07: user enumeration).
const INVALID_CREDENTIALS = { error: 'Invalid credentials' };

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const user = await queryOne(`SELECT * FROM users WHERE username=$1`, [username]);

    // Always run bcrypt.compare, even for a non-existent user, against a
    // dummy hash — otherwise response time leaks whether the username
    // exists (timing side channel / user enumeration).
    const hashToCheck = user?.password_hash || '$2a$12$invalidsaltinvalidsaltinvalidsalOu';
    const valid = await bcrypt.compare(password, hashToCheck);

    if (!user || !user.is_active || !valid) {
      if (user && !valid) {
        await query(
          `UPDATE users SET failed_login_attempts=failed_login_attempts+1, last_failed_login=NOW(),
           is_locked=CASE WHEN failed_login_attempts+1>=5 THEN 1 ELSE 0 END WHERE user_id=$1`,
          [user.user_id],
        );
      }
      return res.status(401).json(INVALID_CREDENTIALS);
    }
    if (user.is_locked) return res.status(403).json({ error: 'Account locked — contact administrator' });

    await query(
      `UPDATE users SET failed_login_attempts=0, last_login_at=NOW(), last_login_ip=$2 WHERE user_id=$1`,
      [user.user_id, req.ip],
    );

    const token = generateToken(user);
    res.json({
      token,
      must_change_password: !!user.must_change_password,
      user: { user_id: user.user_id, username: user.username, full_name: user.full_name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/register
//
// OWASP A01 (Broken Access Control): this is a defense system with
// role-based access (ADMIN/OPERATOR/VIEWER). Open self-registration lets any
// anonymous caller mint an account and start probing the API. Account
// creation is admin-only — see POST /api/users for the authenticated
// equivalent — this endpoint now requires an ADMIN token too, so it exists
// only for scripted provisioning, not public sign-up.
router.post('/register', authenticate, requireRole('ADMIN'), authLimiter, async (req, res) => {
  try {
    const { username, password, full_name, email, role = 'VIEWER' } = req.body;
    if (!username || !password || !full_name) {
      return res.status(400).json({ error: 'username, password, full_name required' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'username must be 3-32 characters: letters, numbers, dot, underscore, hyphen' });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const existing = await queryOne('SELECT user_id FROM users WHERE username=$1', [username]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const allowedRoles = VALID_ROLES;
    const safeRole = allowedRoles.includes(String(role).toUpperCase()) ? String(role).toUpperCase() : 'VIEWER';

    const hash = await bcrypt.hash(password, 12);
    const user = await queryOne(
      `INSERT INTO users(username, password_hash, full_name, email, role, created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING user_id, username, full_name, email, role`,
      [username, hash, full_name, email || null, safeRole, req.user.username],
    );
    res.status(201).json({ user });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await queryOne(
      `SELECT user_id, username, full_name, email, phone, role, last_login_at, created_at, (must_change_password::int = 1) AS must_change_password FROM users WHERE user_id=$1`,
      [req.user.sub],
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', authenticate, async (req, res) => {
  try {
    const user = await queryOne(
      'SELECT user_id, username, full_name, email, role, is_active, must_change_password FROM users WHERE user_id=$1',
      [req.user.sub],
    );
    if (!user || !user.is_active) return res.status(404).json({ error: 'Not found' });
    res.json({ token: generateToken(user) });
  } catch (err) {
    console.error('[auth/refresh]', err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// POST /api/auth/change-password — a self-service alternative to the
// ADMIN-only PUT /api/users/:id/password, so a logged-in user can rotate
// their own credential without needing elevated privileges.
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password required' });
    }
    const pwError = validatePasswordStrength(new_password);
    if (pwError) return res.status(400).json({ error: pwError });

    const user = await queryOne('SELECT * FROM users WHERE user_id=$1', [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE users SET password_hash=$1, must_change_password=0, updated_at=NOW() WHERE user_id=$2',
      [hash, user.user_id],
    );
    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('[auth/change-password]', err);
    res.status(500).json({ error: 'Password change failed' });
  }
});


// GET /api/auth/media-token
//
// Issues a short-lived (5 min), narrowly-scoped token safe to embed in a
// <video>/<img> src URL — the login JWT stays header-only (see A07 fix in
// middleware/auth.js), but a media element genuinely can't attach headers,
// so this gives the frontend a purpose-built alternative instead of either
// reverting the header-only fix or leaving playback broken.
router.get('/media-token', authenticate, (req, res) => {
  res.json({ token: generateMediaToken(req.user), expires_in: 300 });
});

module.exports = router;
