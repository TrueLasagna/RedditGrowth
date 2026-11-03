const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');

const { db } = require('./src/db');
const auth = require('./src/auth');
const flash = require('./src/flash');
const helpers = require('./src/helpers');
const { getLogo } = require('./src/uploads');

// Creates the tables and, on the very first run, the admin account from
// ADMIN_USERNAME / ADMIN_PASSWORD (or a generated password printed once).
// One-time admin reset: with ADMIN_RESET set in Vercel, the admin login is replaced
// by ADMIN_USERNAME / ADMIN_PASSWORD. Each username+password pair is applied only
// once, so later changes made under Admin → Settings are kept.
async function applyAdminReset() {
  const { ADMIN_RESET, ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = process.env;
  if (!ADMIN_RESET || !username || !password) return;
  if (auth.validatePassword(password) || !/^[a-zA-Z0-9._-]{3,60}$/.test(username)) {
    console.error('ADMIN_RESET skipped: ADMIN_USERNAME or ADMIN_PASSWORD is not valid.');
    return;
  }
  const marker = crypto.createHash('sha256').update(`${username}\n${password}`).digest('hex');
  const hash = await auth.hashPassword(password);
  const applied = await db.tx(async (t) => {
    await t.one('SELECT pg_advisory_xact_lock(724002)');
    const done = await t.one("SELECT value FROM app_meta WHERE key = 'admin_reset'");
    if (done && done.value === marker) return false;
    const admin = await t.one('SELECT id FROM admins ORDER BY id LIMIT 1');
    if (admin) {
      await t.run('DELETE FROM admins WHERE lower(username) = lower($1) AND id <> $2', username, admin.id);
      await t.run('UPDATE admins SET username = $1, password_hash = $2 WHERE id = $3', username, hash, admin.id);
      await t.run("DELETE FROM sessions WHERE role = 'admin'");
    } else {
      await t.run('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', username, hash);
    }
    await t.run(`INSERT INTO app_meta (key, value) VALUES ('admin_reset', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, marker);
    return true;
  });
  if (applied) console.log(`Admin login reset from ADMIN_USERNAME / ADMIN_PASSWORD (username: ${username}).`);
}

let setup;
function ensureSetup() {
  return (setup ||= (async () => {
    await db.ready();
    await applyAdminReset();
    if (await db.one('SELECT 1 FROM admins LIMIT 1')) return;
    const username = process.env.ADMIN_USERNAME || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    const generated = !password;
    if (generated) password = crypto.randomBytes(9).toString('base64url');
    const made = await db.run('INSERT INTO admins (username, password_hash) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM admins)',
      username, await auth.hashPassword(password));
    if (made) {
      console.log(`\n  Admin account created → username: ${username}` +
        (generated ? `  password: ${password}\n  (Save this now, then change it under Admin → Settings.)\n` : '\n'));
    }
  })().catch((e) => { setup = null; throw e; }));
}

const app = express();
app.set('view engine', 'ejs');
app.engine('ejs', require('ejs').__express); // explicit so Vercel bundles ejs
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      styleSrcAttr: ["'unsafe-inline'"], // only used for progress-bar widths
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// On Vercel, files in public/ are served by its CDN before reaching this app.
// Locally, this serves them (e.g. public/static/css/styles.css → /static/css/styles.css).
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', index: false }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use((req, res, next) => { req.body ??= {}; next(); });
// If the database isn't reachable, say why (no secrets) so it can be fixed in Vercel.
function setupHint(e) {
  if (!process.env.DATABASE_URL && process.env.VERCEL) return 'DATABASE_URL is not set. In Vercel, add it under Settings → Environment Variables (tick Production), then redeploy.';
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') return "Can't reach the database server. Check that DATABASE_URL is the full Neon connection string, then redeploy.";
  if (e.code === '28P01' || e.code === '28000') return 'The database rejected the password. Copy the connection string again from Neon → Connect, update DATABASE_URL in Vercel, then redeploy.';
  if (e.code === '3D000') return 'The database name in DATABASE_URL does not exist in Neon. Copy the connection string again from Neon → Connect.';
  if (/Invalid URL|invalid connection/i.test(e.message)) return 'DATABASE_URL is not a valid connection string. It should start with postgresql:// and have no quotes or spaces.';
  return `Database error${e.code ? ` (code ${e.code})` : ''}. Check DATABASE_URL in Vercel, then redeploy.`;
}
app.use(async (req, res, next) => {
  try { await ensureSetup(); } catch (e) {
    console.error('Setup failed:', e);
    return res.status(503).render('error', { title: 'Database not connected', message: setupHint(e) });
  }
  next();
});
app.use(auth.loadSession);
app.use(flash);

// Template helpers available in every view.
Object.assign(app.locals, helpers);
const customLogo = ['png', 'svg', 'jpg', 'webp'].find((e) => fs.existsSync(path.join(__dirname, 'public/static/img', `logo.${e}`)));
app.locals.brandLogo = customLogo ? `/static/img/logo.${customLogo}` : null;

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.set('Cache-Control', 'no-store');
  next();
});

// CSRF check for every form post (multipart logo uploads are checked after parsing).
app.use((req, res, next) => {
  if (req.is('multipart/form-data')) return next();
  if (req.method === 'POST' && ['/login', '/admin/login'].includes(req.path)) return next();
  return auth.checkCsrf(req, res, next);
});

// Logos are only served to the admin or to the client they belong to.
app.get('/logo/:clientId', async (req, res) => {
  const id = Number(req.params.clientId);
  const s = req.session;
  if (!Number.isInteger(id) || !s || !(s.role === 'admin' || (s.role === 'client' && s.userId === id))) return res.sendStatus(404);
  const logo = await getLogo(id);
  if (!logo) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.type(logo.mime).send(Buffer.from(logo.data));
});

app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/client'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: "We couldn't find that page." }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please go back and try again.' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`RedditGrowth portal running on http://localhost:${PORT}`));
}
module.exports = app;
module.exports.ensureSetup = ensureSetup;
