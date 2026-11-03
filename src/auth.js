const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE = 'rg_session';
const SESSION_DAYS = 14;
const BCRYPT_ROUNDS = 12;

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);
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
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
    }
  }
  return out;
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

async function createSession(res, role, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  await db.run('INSERT INTO sessions (token_hash, role, user_id, csrf, expires_at) VALUES ($1,$2,$3,$4,$5)',
    sha256(token), role, userId, csrf, expires);
  setCookie(res, token, SESSION_DAYS * 86400);
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = $1', sha256(token));
  setCookie(res, '', 0);
}

const destroyUserSessions = (role, userId) =>
  db.run('DELETE FROM sessions WHERE role = $1 AND user_id = $2', role, userId);

// Attaches req.session = { role, userId, csrf } when a valid session cookie is present.
async function loadSession(req, res, next) {
  req.session = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = await db.one('SELECT * FROM sessions WHERE token_hash = $1', sha256(token));
    if (row && row.expires_at > Date.now()) {
      req.session = { role: row.role, userId: row.user_id, csrf: row.csrf };
    } else if (row) {
      await db.run('DELETE FROM sessions WHERE token_hash = $1', row.token_hash);
    }
  }
  res.locals.csrf = req.session ? req.session.csrf : '';
  next();
}

// Every state-changing request from a logged-in user must carry the session's CSRF token.
function checkCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  if (!req.session || !sent || sent.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf))) {
    return res.status(403).send('Your session expired. Please go back, refresh the page and try again.');
  }
  next();
}

// Login throttle stored in the database (works across serverless instances):
// 8 failed attempts per IP+username per 15 minutes.
const WINDOW = 15 * 60 * 1000;
async function tooManyAttempts(key) {
  const a = await db.one('SELECT * FROM login_attempts WHERE key = $1', key);
  return !!a && Date.now() - a.first_at < WINDOW && a.count >= 8;
}
async function recordFailure(key) {
  const now = Date.now();
  await db.run(`INSERT INTO login_attempts (key, first_at, count) VALUES ($1, $2, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN login_attempts.first_at < $3 THEN 1 ELSE login_attempts.count + 1 END,
      first_at = CASE WHEN login_attempts.first_at < $3 THEN $2 ELSE login_attempts.first_at END`,
  key, now, now - WINDOW);
}
const clearFailures = (key) => db.run('DELETE FROM login_attempts WHERE key = $1', key);

// Called occasionally on login instead of a timer (serverless has no long-running process).
async function purgeExpired() {
  await db.run('DELETE FROM sessions WHERE expires_at < $1', Date.now());
  await db.run('DELETE FROM login_attempts WHERE first_at < $1', Date.now() - WINDOW);
}

module.exports = {
  hashPassword, checkPassword, validatePassword,
  createSession, destroySession, destroyUserSessions, loadSession, checkCsrf,
  tooManyAttempts, recordFailure, clearFailures, purgeExpired,
};
