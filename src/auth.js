const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE = 'rg_session';
const SESSION_DAYS = 14;
const BCRYPT_ROUNDS = 12;

const hashPassword = (pw) => bcrypt.hashSync(pw, BCRYPT_ROUNDS);
const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validatePassword(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

function createSession(res, role, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  db.prepare('INSERT INTO sessions (token_hash, role, user_id, csrf, expires_at) VALUES (?,?,?,?,?)')
    .run(sha256(token), role, userId, csrf, expires);
  setCookie(res, token, SESSION_DAYS * 86400);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(res, '', 0);
}

function destroyUserSessions(role, userId) {
  db.prepare('DELETE FROM sessions WHERE role = ? AND user_id = ?').run(role, userId);
}

// Attaches req.session = { role, userId, csrf } when a valid session cookie is present.
function loadSession(req, res, next) {
  req.session = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (row && row.expires_at > Date.now()) {
      req.session = { role: row.role, userId: row.user_id, csrf: row.csrf };
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    }
  }
  res.locals.csrf = req.session ? req.session.csrf : '';
  next();
}

// Every state-changing request from a logged-in user must carry the session's CSRF token.
function checkCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!req.session || !sent || sent.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf))) {
    return res.status(403).send('Your session expired. Please go back, refresh the page and try again.');
  }
  next();
}

// Simple in-memory login throttle: 8 failed attempts per IP+username per 15 minutes.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) return false;
  return a.count >= 8;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}
const clearFailures = (key) => attempts.delete(key);

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  hashPassword, checkPassword, validatePassword,
  createSession, destroySession, destroyUserSessions, loadSession, checkCsrf,
  tooManyAttempts, recordFailure, clearFailures, purgeExpiredSessions,
};
