/**
 * Centralized security configuration.
 *
 * OWASP A02 (Cryptographic Failures) / A05 (Security Misconfiguration):
 * Secrets must never fall back to a hardcoded value. If a secret is missing,
 * the process fails fast at startup instead of silently running with a
 * well-known default that an attacker could look up on GitHub.
 */

const REQUIRED_IN_PRODUCTION = process.env.NODE_ENV === 'production';

function requireEnv(name, { minLength = 0, devFallback = null } = {}) {
  const value = process.env[name];

  if (!value) {
    if (!REQUIRED_IN_PRODUCTION && devFallback) {
      // Only ever used outside production, and always a randomly generated
      // per-process value — never a fixed string — so it can't be guessed
      // ahead of time or reused against another deployment.
      console.warn(
        `[SECURITY] ${name} is not set. Using a random development-only value. ` +
        `This is NOT safe for production — set ${name} in your environment.`,
      );
      return devFallback();
    }
    throw new Error(
      `[SECURITY] Required environment variable ${name} is not set. ` +
      `Refusing to start with an insecure default. See server/.env.example.`,
    );
  }

  if (value.length < minLength) {
    throw new Error(
      `[SECURITY] ${name} is too short (min ${minLength} characters). ` +
      `Generate one with: openssl rand -base64 48`,
    );
  }

  return value;
}

const crypto = require('crypto');

const JWT_SECRET = requireEnv('JWT_SECRET', {
  minLength: 32,
  devFallback: () => crypto.randomBytes(48).toString('hex'),
});

// DB password: allow empty only for local dev via explicit opt-in, never a
// baked-in literal password shipped in source control.
const DB_PASSWORD = (() => {
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD;
  if (REQUIRED_IN_PRODUCTION) {
    throw new Error('[SECURITY] DB_PASSWORD is required in production.');
  }
  console.warn('[SECURITY] DB_PASSWORD is not set — using empty password for local dev only.');
  return '';
})();

// Password policy (OWASP ASVS 2.1 style): length matters far more than
// forced character classes, which push users toward predictable patterns.
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

function validatePasswordStrength(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  // Reject a short list of extremely common / breach-listed passwords as a
  // cheap first line of defense (A07: Identification & Authentication Failures).
  const COMMON = new Set([
    'password', 'password1', '123456789', 'qwerty123', 'letmein123',
    'admin1234', 'welcome123', 'changeme123', 'railway123',
  ]);
  if (COMMON.has(password.toLowerCase())) {
    return 'Password is too common — choose a less predictable password';
  }
  return null; // valid
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (!email) return true; // email is optional in this schema
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

// Must stay in sync with the `chk_user_role` CHECK constraint on users.role
// in schema.sql. Centralized here so every route validating a role uses the
// same list instead of each file hand-maintaining its own (which is exactly
// how the previous drift happened: auth code only knew about 3 of the 5
// roles the database actually accepts).
const VALID_ROLES = ['ADMIN', 'OPERATOR', 'MAINTENANCE', 'VIEWER', 'API_CLIENT'];

module.exports = {
  JWT_SECRET,
  DB_PASSWORD,
  PASSWORD_MIN_LENGTH,
  VALID_ROLES,
  validatePasswordStrength,
  validateEmail,
  validateUsername,
  isProduction: REQUIRED_IN_PRODUCTION,
};
