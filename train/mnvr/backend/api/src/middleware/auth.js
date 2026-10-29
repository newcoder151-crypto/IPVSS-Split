const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { JWT_SECRET, VALID_ROLES } = require('../config/security');

const ISSUER = 'railway-nvr-api';

function authenticate(req, res, next) {
  const h = req.headers.authorization;
  const token = h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;

  if (!token) return res.status(401).json({ error: 'Authorization token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
    });
    if (!decoded || !decoded.sub || !VALID_ROLES.includes(decoded.role)) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded;

    const SELF_SERVICE_PATHS = new Set([
      '/api/auth/change-password',
      '/api/auth/me',
      '/api/auth/refresh',
    ]);
    if (decoded.must_change_password && !SELF_SERVICE_PATHS.has(req.baseUrl + req.path)) {
      return res.status(403).json({
        error: 'Password change required before continuing',
        code: 'MUST_CHANGE_PASSWORD',
      });
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function generateMediaToken(user) {
  return jwt.sign(
    { sub: user.sub, role: user.role, purpose: 'media' },
    JWT_SECRET,
    { expiresIn: '5m', issuer: ISSUER, algorithm: 'HS256' },
  );
}

function authenticateMedia(req, res, next) {
  const h = req.headers.authorization;
  const headerToken = h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const token = headerToken || queryToken;

  if (!token) return res.status(401).json({ error: 'Authorization token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
    if (!decoded || !decoded.sub || !VALID_ROLES.includes(decoded.role)) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (queryToken && !headerToken && decoded.purpose !== 'media') {
      return res.status(401).json({ error: 'This token cannot be used as a URL parameter' });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  const wanted = roles.map((r) => r.toUpperCase());
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!wanted.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

function generateToken(user) {
  return jwt.sign(
    {
      sub: user.user_id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      must_change_password: !!user.must_change_password,
    },
    JWT_SECRET,
    { expiresIn: '8h', issuer: ISSUER, algorithm: 'HS256' },
  );
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
  keyGenerator: (req) => `${req.ip}:${(req.body && req.body.username) || ''}`,
});

module.exports = { authenticate, authenticateMedia, requireRole, generateToken, generateMediaToken, authLimiter };
