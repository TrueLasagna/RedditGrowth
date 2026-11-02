const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const up = require('../uploads');
const { parseViews, parseMoneyToCents, subredditName, clean, PERIODS } = require('../helpers');

const router = express.Router();

/* ---------- login ---------- */

router.get('/login', (req, res) => {
  if (req.session?.role === 'admin') return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin sign in', error: null, username: '' });
});

router.post('/login', (req, res) => {
  const username = clean(req.body.username, 100);
  const password = String(req.body.password || '');
  const key = `admin:${req.ip}:${username.toLowerCase()}`;
  if (auth.tooManyAttempts(key)) {
    return res.status(429).render('admin/login', { title: 'Admin sign in', username, error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !auth.checkPassword(password, admin.password_hash)) {
    auth.recordFailure(key);
    return res.status(401).render('admin/login', { title: 'Admin sign in', username, error: 'Incorrect username or password.' });
  }
  auth.clearFailures(key);
  if (req.session) auth.destroySession(req, res);
  auth.createSession(res, 'admin', admin.id);
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/admin/login');
});

/* ---------- everything below requires an admin ---------- */

router.use((req, res, next) => {
  if (req.session?.role !== 'admin') return res.redirect('/admin/login');
  const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(req.session.userId);
  if (!admin) { auth.destroySession(req, res); return res.redirect('/admin/login'); }
  res.locals.admin = admin;
  res.locals.pendingTotal = db.prepare("SELECT COUNT(*) n FROM drafts WHERE status = 'pending'").get().n;
  next();
});

const clientStats = `
  SELECT c.*,
    (SELECT COALESCE(SUM(views),0) FROM posts p WHERE p.client_id = c.id) AS total_views,
    (SELECT COUNT(*) FROM posts p WHERE p.client_id = c.id) AS post_count,
    (SELECT COUNT(*) FROM drafts d WHERE d.client_id = c.id AND d.status = 'pending') AS pending_drafts,
    (SELECT COUNT(*) FROM drafts d WHERE d.client_id = c.id AND d.status = 'approved') AS approved_drafts,
    (SELECT COUNT(*) FROM drafts d WHERE d.client_id = c.id AND d.status = 'denied') AS denied_drafts
  FROM clients c`;

/* ---------- overview ---------- */

router.get('/', (req, res) => {
  const clients = db.prepare(`${clientStats} ORDER BY c.active DESC, c.company_name COLLATE NOCASE`).all();
  const active = clients.filter((c) => c.active);
  const stats = {
    total: clients.length,
    active: active.length,
    inactive: clients.length - active.length,
    monthlyRevenue: active.filter((c) => c.billing_period === 'month').reduce((s, c) => s + c.price_cents, 0),
    otherRevenue: active.filter((c) => c.billing_period !== 'month').reduce((s, c) => s + c.price_cents, 0),
    viewsDelivered: clients.reduce((s, c) => s + c.total_views, 0),
    viewsPromised: active.reduce((s, c) => s + c.plan_views, 0),
    pending: clients.reduce((s, c) => s + c.pending_drafts, 0),
  };
  res.render('admin/overview', { title: 'Overview', clients, stats, PERIODS });
});

/* ---------- create client ---------- */

function readClientForm(body, { requirePassword }) {
  const f = {
    company_name: clean(body.company_name, 120),
    contact_name: clean(body.contact_name, 120),
    contact_email: clean(body.contact_email, 200),
    username: clean(body.username, 60),
    password: String(body.password || ''),
    plan_views: body.plan_choice && body.plan_choice !== 'custom' ? parseViews(body.plan_choice) : parseViews(body.plan_custom),
    price_cents: parseMoneyToCents(body.price),
    billing_period: PERIODS[body.billing_period] ? body.billing_period : 'month',
    notes: clean(body.notes, 2000),
  };
  const errors = [];
  if (!f.company_name) errors.push('Company name is required.');
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(f.username)) errors.push('Username must be 3–60 characters: letters, numbers, dots, dashes or underscores.');
  if (requirePassword || f.password) {
    const pwErr = auth.validatePassword(f.password);
    if (pwErr) errors.push(pwErr);
  }
  if (!Number.isFinite(f.plan_views) || f.plan_views <= 0) errors.push('Choose a view plan (for example 250k, 500k or 1M).');
  if (!Number.isFinite(f.price_cents)) errors.push('Enter a valid price, for example 1500 or 1499.99.');
  if (f.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contact_email)) errors.push('Contact email looks invalid.');
  return { f, errors };
}

router.get('/clients/new', (req, res) => {
  res.render('admin/client-new', { title: 'New client', errors: [], form: { billing_period: 'month', plan_choice: '500000' } });
});

router.post('/clients', (req, res) => {
  const { f, errors } = readClientForm(req.body, { requirePassword: true });
  if (!errors.length && db.prepare('SELECT 1 FROM clients WHERE username = ?').get(f.username)) {
    errors.push('That username is already taken.');
  }
  if (errors.length) {
    return res.status(400).render('admin/client-new', { title: 'New client', errors, form: { ...req.body, password: '' } });
  }
  const info = db.prepare(`INSERT INTO clients
    (company_name, contact_name, contact_email, username, password_hash, plan_views, price_cents, billing_period, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    f.company_name, f.contact_name, f.contact_email, f.username, auth.hashPassword(f.password),
    f.plan_views, f.price_cents, f.billing_period, f.notes);
  res.flash('success', `${f.company_name} was created. Upload their logo below.`);
  res.redirect(`/admin/clients/${info.lastInsertRowid}?tab=settings`);
});

/* ---------- client workspace ---------- */

// Loads the client for any /clients/:id route; 404s if it doesn't exist.
router.param('id', (req, res, next, id) => {
  const client = db.prepare(`${clientStats} WHERE c.id = ?`).get(Number(id));
  if (!client) return res.status(404).render('error', { title: 'Client not found', message: 'That client does not exist.' });
  req.client = client;
  next();
});

const back = (req, tab) => `/admin/clients/${req.client.id}?tab=${tab}`;

router.get('/clients/:id', (req, res) => {
  const tab = ['posts', 'drafts', 'settings'].includes(req.query.tab) ? req.query.tab : 'posts';
  const posts = db.prepare('SELECT * FROM posts WHERE client_id = ? ORDER BY created_at DESC, id DESC').all(req.client.id);
  const drafts = db.prepare(`SELECT * FROM drafts WHERE client_id = ?
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC, id DESC`).all(req.client.id);
  res.render('admin/client', { title: req.client.company_name, client: req.client, tab, posts, drafts, PERIODS, errors: [] });
});

router.post('/clients/:id', (req, res) => {
  const { f, errors } = readClientForm({ ...req.body, password: '' }, { requirePassword: false });
  if (!errors.length && db.prepare('SELECT 1 FROM clients WHERE username = ? AND id != ?').get(f.username, req.client.id)) {
    errors.push('That username is already taken.');
  }
  if (errors.length) {
    res.flash('error', errors.join(' '));
    return res.redirect(back(req, 'settings'));
  }
  db.prepare(`UPDATE clients SET company_name=?, contact_name=?, contact_email=?, username=?,
    plan_views=?, price_cents=?, billing_period=?, notes=? WHERE id=?`).run(
    f.company_name, f.contact_name, f.contact_email, f.username,
    f.plan_views, f.price_cents, f.billing_period, f.notes, req.client.id);
  res.flash('success', 'Client details and plan saved.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/password', (req, res) => {
  const pw = String(req.body.password || '');
  const err = auth.validatePassword(pw);
  if (err) { res.flash('error', err); return res.redirect(back(req, 'settings')); }
  db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), req.client.id);
  auth.destroyUserSessions('client', req.client.id);
  res.flash('success', 'Password updated. The client has been signed out of any open sessions.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/status', (req, res) => {
  const active = req.body.active === '1' ? 1 : 0;
  db.prepare('UPDATE clients SET active = ? WHERE id = ?').run(active, req.client.id);
  if (!active) auth.destroyUserSessions('client', req.client.id);
  res.flash('success', active ? 'Client reactivated. They can sign in again.' : 'Client deactivated. They can no longer sign in.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/logo', (req, res) => {
  up.logoUpload(req, res, (err) => {
    if (err) {
      res.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'Logo must be 2 MB or smaller.' : 'Upload failed.');
      return res.redirect(back(req, 'settings'));
    }
    auth.checkCsrf(req, res, () => {
      if (!req.file) { res.flash('error', 'Choose an image to upload.'); return res.redirect(back(req, 'settings')); }
      let name;
      try { name = up.saveLogo(req.client.id, req.file.buffer); } catch (e) {
        res.flash('error', e.message); return res.redirect(back(req, 'settings'));
      }
      up.deleteLogo(req.client.id, req.client.logo_file);
      db.prepare('UPDATE clients SET logo_file = ? WHERE id = ?').run(name, req.client.id);
      res.flash('success', 'Logo updated.');
      res.redirect(back(req, 'settings'));
    });
  });
});

router.post('/clients/:id/logo/delete', (req, res) => {
  up.deleteLogo(req.client.id, req.client.logo_file);
  db.prepare('UPDATE clients SET logo_file = NULL WHERE id = ?').run(req.client.id);
  res.flash('success', 'Logo removed.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/delete', (req, res) => {
  if (clean(req.body.confirm_name) !== req.client.company_name) {
    res.flash('error', 'Type the company name exactly to confirm deletion.');
    return res.redirect(back(req, 'settings'));
  }
  auth.destroyUserSessions('client', req.client.id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.client.id);
  up.deleteClientFiles(req.client.id);
  res.flash('success', `${req.client.company_name} and all of its posts and drafts were deleted.`);
  res.redirect('/admin');
});

/* ---------- live posts ---------- */

function readPost(body) {
  const p = {
    subreddit: subredditName(body.subreddit).slice(0, 50),
    title: clean(body.title, 300),
    body: clean(body.body, 40000),
    url: clean(body.url, 500),
    views: body.views === undefined || body.views === '' ? 0 : parseViews(body.views),
  };
  const errors = [];
  if (!/^[A-Za-z0-9_]{2,50}$/.test(p.subreddit)) errors.push('Enter a valid subreddit, for example r/marketing.');
  if (!p.title) errors.push('Post title is required.');
  if (!Number.isFinite(p.views) || p.views < 0) errors.push('View count must be a number, for example 12500 or 12.5k.');
  if (p.url && !/^https?:\/\//i.test(p.url)) errors.push('Post link must start with http:// or https://');
  return { p, errors };
}

router.post('/clients/:id/posts', (req, res) => {
  const { p, errors } = readPost(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'posts')); }
  db.prepare('INSERT INTO posts (client_id, subreddit, title, body, url, views) VALUES (?,?,?,?,?,?)')
    .run(req.client.id, p.subreddit, p.title, p.body, p.url, p.views);
  res.flash('success', 'Live post added.');
  res.redirect(back(req, 'posts'));
});

router.post('/clients/:id/posts/:postId', (req, res) => {
  const { p, errors } = readPost(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'posts')); }
  const r = db.prepare(`UPDATE posts SET subreddit=?, title=?, body=?, url=?, views=?, views_updated_at=datetime('now')
    WHERE id=? AND client_id=?`).run(p.subreddit, p.title, p.body, p.url, p.views, Number(req.params.postId), req.client.id);
  res.flash(r.changes ? 'success' : 'error', r.changes ? 'Post updated.' : 'Post not found.');
  res.redirect(back(req, 'posts'));
});

router.post('/clients/:id/posts/:postId/views', (req, res) => {
  const views = parseViews(req.body.views);
  if (!Number.isFinite(views) || views < 0) {
    res.flash('error', 'View count must be a number, for example 12500 or 12.5k.');
    return res.redirect(back(req, 'posts'));
  }
  const r = db.prepare("UPDATE posts SET views=?, views_updated_at=datetime('now') WHERE id=? AND client_id=?")
    .run(views, Number(req.params.postId), req.client.id);
  res.flash(r.changes ? 'success' : 'error', r.changes ? 'View count updated.' : 'Post not found.');
  res.redirect(back(req, 'posts'));
});

router.post('/clients/:id/posts/:postId/delete', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id=? AND client_id=?').run(Number(req.params.postId), req.client.id);
  res.flash('success', 'Post deleted.');
  res.redirect(back(req, 'posts'));
});

/* ---------- drafts ---------- */

function readDraft(body) {
  const d = {
    subreddit: subredditName(body.subreddit).slice(0, 50),
    title: clean(body.title, 300),
    body: clean(body.body, 40000),
  };
  const errors = [];
  if (!/^[A-Za-z0-9_]{2,50}$/.test(d.subreddit)) errors.push('Enter a valid subreddit, for example r/marketing.');
  if (!d.title) errors.push('Draft title is required.');
  return { d, errors };
}

router.post('/clients/:id/drafts', (req, res) => {
  const { d, errors } = readDraft(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'drafts')); }
  db.prepare('INSERT INTO drafts (client_id, subreddit, title, body) VALUES (?,?,?,?)').run(req.client.id, d.subreddit, d.title, d.body);
  res.flash('success', 'Draft added. The client can now approve or deny it.');
  res.redirect(back(req, 'drafts'));
});

router.post('/clients/:id/drafts/:draftId', (req, res) => {
  const { d, errors } = readDraft(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'drafts')); }
  const id = Number(req.params.draftId);
  const old = db.prepare('SELECT * FROM drafts WHERE id=? AND client_id=?').get(id, req.client.id);
  if (!old) { res.flash('error', 'Draft not found.'); return res.redirect(back(req, 'drafts')); }
  // Changing the content sends the draft back to the client for a fresh decision.
  const changed = old.subreddit !== d.subreddit || old.title !== d.title || old.body !== d.body;
  db.prepare(`UPDATE drafts SET subreddit=?, title=?, body=?,
      status = CASE WHEN ? THEN 'pending' ELSE status END,
      decided_at = CASE WHEN ? THEN NULL ELSE decided_at END
    WHERE id=? AND client_id=?`).run(d.subreddit, d.title, d.body, changed ? 1 : 0, changed ? 1 : 0, id, req.client.id);
  res.flash('success', changed && old.status !== 'pending' ? 'Draft updated and sent back to the client for review.' : 'Draft updated.');
  res.redirect(back(req, 'drafts'));
});

router.post('/clients/:id/drafts/:draftId/delete', (req, res) => {
  db.prepare('DELETE FROM drafts WHERE id=? AND client_id=?').run(Number(req.params.draftId), req.client.id);
  res.flash('success', 'Draft deleted.');
  res.redirect(back(req, 'drafts'));
});

// Turn an approved draft into a live post (views start at 0) and remove the draft.
router.post('/clients/:id/drafts/:draftId/publish', (req, res) => {
  const d = db.prepare("SELECT * FROM drafts WHERE id=? AND client_id=? AND status='approved'").get(Number(req.params.draftId), req.client.id);
  if (!d) { res.flash('error', 'Only approved drafts can be moved to live posts.'); return res.redirect(back(req, 'drafts')); }
  const url = clean(req.body.url, 500);
  db.transaction(() => {
    db.prepare('INSERT INTO posts (client_id, subreddit, title, body, url, views) VALUES (?,?,?,?,?,0)')
      .run(req.client.id, d.subreddit, d.title, d.body, /^https?:\/\//i.test(url) ? url : '');
    db.prepare('DELETE FROM drafts WHERE id=?').run(d.id);
  })();
  res.flash('success', 'Draft moved to live posts. Update its views as they come in.');
  res.redirect(back(req, 'posts'));
});

/* ---------- admin settings ---------- */

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings' }));

router.post('/settings/password', (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.userId);
  if (!auth.checkPassword(String(req.body.current || ''), admin.password_hash)) {
    res.flash('error', 'Current password is incorrect.');
    return res.redirect('/admin/settings');
  }
  const err = auth.validatePassword(req.body.password);
  if (err || req.body.password !== req.body.confirm) {
    res.flash('error', err || 'New passwords do not match.');
    return res.redirect('/admin/settings');
  }
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), admin.id);
  auth.destroyUserSessions('admin', admin.id);
  auth.createSession(res, 'admin', admin.id);
  res.flash('success', 'Password changed.');
  res.redirect('/admin/settings');
});

module.exports = router;
