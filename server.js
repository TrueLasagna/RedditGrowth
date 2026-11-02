const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');

const { db } = require('./src/db');
const auth = require('./src/auth');
const flash = require('./src/flash');
const helpers = require('./src/helpers');
const { logoPath } = require('./src/uploads');

// First run: create the admin account from ADMIN_USERNAME / ADMIN_PASSWORD,
// or generate a password and print it once.
if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, auth.hashPassword(password));
  console.log(`\n  Admin account created → username: ${username}` +
    (generated ? `  password: ${password}\n  (Save this now, then change it under Admin → Settings.)\n` : '\n'));
}

const app = express();
app.set('view engine', 'ejs');
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

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(auth.loadSession);
app.use(flash);

// Template helpers available in every view.
Object.assign(app.locals, helpers);
const customLogo = ['png', 'svg', 'jpg', 'webp'].find((e) => fs.existsSync(path.join(__dirname, 'public/img', `logo.${e}`)));
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
app.get('/logo/:clientId', (req, res) => {
  const id = Number(req.params.clientId);
  const s = req.session;
  if (!s || !(s.role === 'admin' || (s.role === 'client' && s.userId === id))) return res.sendStatus(404);
  const row = db.prepare('SELECT logo_file FROM clients WHERE id = ?').get(id);
  const p = row && logoPath(id, row.logo_file);
  if (!p || !fs.existsSync(p)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(p);
});

app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/client'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: "We couldn't find that page." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please go back and try again.' });
});

setInterval(auth.purgeExpiredSessions, 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`RedditGrowth portal running on http://localhost:${PORT}`));
}
module.exports = app;
