const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const up = require('../uploads');
const { parseViews, parseMoneyToCents, subredditName, clean, PERIODS } = require('../helpers');

const router = express.Router();
const MAX_NUMBER = 1e12; // keeps typos like "9999999999999999" out of the database

/* ---------- login ---------- */

router.get('/login', (req, res) => {
  if (req.session?.role === 'admin') return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin sign in', error: null, username: '' });
});

router.post('/login', async (req, res) => {
  const username = clean(req.body.username, 100);
  const password = String(req.body.password || '');
  const key = `admin:${req.ip}:${username.toLowerCase()}`;
  const fail = (status, error) => res.status(status).render('admin/login', { title: 'Admin sign in', username, error });
  if (await auth.tooManyAttempts(key)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
  const admin = await db.one('SELECT * FROM admins WHERE lower(username) = lower($1)', username);
  if (!admin || !(await auth.checkPassword(password, admin.password_hash))) {
    await auth.recordFailure(key);
    return fail(401, 'Incorrect username or password.');
  }
  await auth.clearFailures(key);
  if (req.session) await auth.destroySession(req, res);
  await auth.createSession(res, 'admin', admin.id);
  if (Math.random() < 0.1) await auth.purgeExpired();
  res.redirect('/admin');
});

router.post('/logout', async (req, res) => {
  await auth.destroySession(req, res);
  res.redirect('/admin/login');
});

/* ---------- everything below requires an admin ---------- */

router.use(async (req, res, next) => {
  if (req.session?.role !== 'admin') return res.redirect('/admin/login');
  const admin = await db.one('SELECT id, username FROM admins WHERE id = $1', req.session.userId);
  if (!admin) { await auth.destroySession(req, res); return res.redirect('/admin/login'); }
  res.locals.admin = admin;
  res.locals.pendingTotal = (await db.one("SELECT COUNT(*) n FROM drafts WHERE status = 'pending'")).n;
  next();
});

const clientStats = `
  SELECT c.*,
    (SELECT COALESCE(SUM(views),0)::bigint FROM posts p WHERE p.client_id = c.id) AS total_views,
    (SELECT COUNT(*) FROM posts p WHERE p.client_id = c.id) AS post_count,
    (SELECT COUNT(*) FROM drafts d WHERE d.client_id = c.id AND d.status = 'pending') AS pending_drafts,
    (SELECT COUNT(*) FROM drafts d WHERE d.client_id = c.id AND d.status = 'approved') AS approved_drafts,
    (SELECT COUNT(*) FROM drafts d WHERE d.client_id = c.id AND d.status = 'denied') AS denied_drafts
  FROM clients c`;

/* ---------- overview ---------- */

router.get('/', async (req, res) => {
  const clients = await db.all(`${clientStats} ORDER BY c.active DESC, lower(c.company_name)`);
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
    billing_period: Object.hasOwn(PERIODS, body.billing_period) ? body.billing_period : 'month',
    notes: clean(body.notes, 2000),
  };
  const errors = [];
  if (!f.company_name) errors.push('Company name is required.');
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(f.username)) errors.push('Username must be 3–60 characters: letters, numbers, dots, dashes or underscores.');
  if (requirePassword || f.password) {
    const pwErr = auth.validatePassword(f.password);
    if (pwErr) errors.push(pwErr);
  }
  if (!Number.isFinite(f.plan_views) || f.plan_views <= 0 || f.plan_views > MAX_NUMBER) errors.push('Choose a view plan (for example 250k, 500k or 1M).');
  if (!Number.isFinite(f.price_cents) || f.price_cents > MAX_NUMBER) errors.push('Enter a valid price, for example 1500 or 1499.99.');
  if (f.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contact_email)) errors.push('Contact email looks invalid.');
  return { f, errors };
}

const usernameTaken = async (username, exceptId = 0) =>
  !!(await db.one('SELECT 1 FROM clients WHERE lower(username) = lower($1) AND id <> $2', username, exceptId));

router.get('/clients/new', (req, res) => {
  res.render('admin/client-new', { title: 'New client', errors: [], form: { billing_period: 'month', plan_choice: '500000' } });
});

router.post('/clients', async (req, res) => {
  const { f, errors } = readClientForm(req.body, { requirePassword: true });
  if (!errors.length && await usernameTaken(f.username)) errors.push('That username is already taken.');
  if (errors.length) {
    return res.status(400).render('admin/client-new', { title: 'New client', errors, form: { ...req.body, password: '' } });
  }
  const row = await db.one(`INSERT INTO clients
    (company_name, contact_name, contact_email, username, password_hash, plan_views, price_cents, billing_period, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  f.company_name, f.contact_name, f.contact_email, f.username, await auth.hashPassword(f.password),
  f.plan_views, f.price_cents, f.billing_period, f.notes);
  res.flash('success', `${f.company_name} was created. Upload their logo below.`);
  res.redirect(`/admin/clients/${row.id}?tab=settings`);
});

/* ---------- client workspace ---------- */

// Loads the client for any /clients/:id route; 404s if it doesn't exist.
router.param('id', async (req, res, next, id) => {
  try {
    const n = Number(id);
    const client = Number.isInteger(n) && n > 0 && n < 2 ** 31 ? await db.one(`${clientStats} WHERE c.id = $1`, n) : null;
    if (!client) return res.status(404).render('error', { title: 'Client not found', message: 'That client does not exist.' });
    req.client = client;
    next();
  } catch (e) { next(e); }
});

const back = (req, tab) => `/admin/clients/${req.client.id}?tab=${tab}`;
const rowId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : 0; };

router.get('/clients/:id', async (req, res) => {
  const tab = ['posts', 'drafts', 'settings'].includes(req.query.tab) ? req.query.tab : 'posts';
  const posts = await db.all('SELECT * FROM posts WHERE client_id = $1 ORDER BY created_at DESC, id DESC', req.client.id);
  const drafts = await db.all(`SELECT * FROM drafts WHERE client_id = $1
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC, id DESC`, req.client.id);
  res.render('admin/client', { title: req.client.company_name, client: req.client, tab, posts, drafts, PERIODS, errors: [] });
});

router.post('/clients/:id', async (req, res) => {
  const { f, errors } = readClientForm({ ...req.body, password: '' }, { requirePassword: false });
  if (!errors.length && await usernameTaken(f.username, req.client.id)) errors.push('That username is already taken.');
  if (errors.length) {
    res.flash('error', errors.join(' '));
    return res.redirect(back(req, 'settings'));
  }
  await db.run(`UPDATE clients SET company_name=$1, contact_name=$2, contact_email=$3, username=$4,
    plan_views=$5, price_cents=$6, billing_period=$7, notes=$8 WHERE id=$9`,
  f.company_name, f.contact_name, f.contact_email, f.username,
  f.plan_views, f.price_cents, f.billing_period, f.notes, req.client.id);
  res.flash('success', 'Client details and plan saved.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/password', async (req, res) => {
  const pw = String(req.body.password || '');
  const err = auth.validatePassword(pw);
  if (err) { res.flash('error', err); return res.redirect(back(req, 'settings')); }
  await db.run('UPDATE clients SET password_hash = $1 WHERE id = $2', await auth.hashPassword(pw), req.client.id);
  await auth.destroyUserSessions('client', req.client.id);
  res.flash('success', 'Password updated. The client has been signed out of any open sessions.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/status', async (req, res) => {
  const active = req.body.active === '1';
  await db.run('UPDATE clients SET active = $1 WHERE id = $2', active, req.client.id);
  if (!active) await auth.destroyUserSessions('client', req.client.id);
  res.flash('success', active ? 'Client reactivated. They can sign in again.' : 'Client deactivated. They can no longer sign in.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/logo', (req, res, next) => {
  up.logoUpload(req, res, (err) => {
    if (err) {
      res.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'Logo must be 2 MB or smaller.' : 'Upload failed.');
      return res.redirect(back(req, 'settings'));
    }
    auth.checkCsrf(req, res, async () => {
      try {
        if (!req.file) { res.flash('error', 'Choose an image to upload.'); return res.redirect(back(req, 'settings')); }
        try { await up.saveLogo(req.client.id, req.file.buffer); } catch (e) {
          if (!/^Logo must/.test(e.message)) throw e;
          res.flash('error', e.message); return res.redirect(back(req, 'settings'));
        }
        res.flash('success', 'Logo updated.');
        res.redirect(back(req, 'settings'));
      } catch (e) { next(e); }
    });
  });
});

router.post('/clients/:id/logo/delete', async (req, res) => {
  await up.deleteLogo(req.client.id);
  res.flash('success', 'Logo removed.');
  res.redirect(back(req, 'settings'));
});

router.post('/clients/:id/delete', async (req, res) => {
  if (clean(req.body.confirm_name) !== req.client.company_name) {
    res.flash('error', 'Type the company name exactly to confirm deletion.');
    return res.redirect(back(req, 'settings'));
  }
  await auth.destroyUserSessions('client', req.client.id);
  // Posts, drafts and logo are removed with it (ON DELETE CASCADE).
  await db.run('DELETE FROM clients WHERE id = $1', req.client.id);
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
  if (!Number.isFinite(p.views) || p.views < 0 || p.views > MAX_NUMBER) errors.push('View count must be a number, for example 12500 or 12.5k.');
  if (p.url && !/^https?:\/\//i.test(p.url)) errors.push('Post link must start with http:// or https://');
  return { p, errors };
}

router.post('/clients/:id/posts', async (req, res) => {
  const { p, errors } = readPost(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'posts')); }
  await db.run('INSERT INTO posts (client_id, subreddit, title, body, url, views) VALUES ($1,$2,$3,$4,$5,$6)',
    req.client.id, p.subreddit, p.title, p.body, p.url, p.views);
  res.flash('success', 'Live post added.');
  res.redirect(back(req, 'posts'));
});

router.post('/clients/:id/posts/:postId', async (req, res) => {
  const { p, errors } = readPost(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'posts')); }
  const n = await db.run(`UPDATE posts SET subreddit=$1, title=$2, body=$3, url=$4, views=$5, views_updated_at=now()
    WHERE id=$6 AND client_id=$7`, p.subreddit, p.title, p.body, p.url, p.views, rowId(req.params.postId), req.client.id);
  res.flash(n ? 'success' : 'error', n ? 'Post updated.' : 'Post not found.');
  res.redirect(back(req, 'posts'));
});

router.post('/clients/:id/posts/:postId/views', async (req, res) => {
  const views = parseViews(req.body.views);
  if (!Number.isFinite(views) || views < 0 || views > MAX_NUMBER) {
    res.flash('error', 'View count must be a number, for example 12500 or 12.5k.');
    return res.redirect(back(req, 'posts'));
  }
  const n = await db.run('UPDATE posts SET views=$1, views_updated_at=now() WHERE id=$2 AND client_id=$3',
    views, rowId(req.params.postId), req.client.id);
  res.flash(n ? 'success' : 'error', n ? 'View count updated.' : 'Post not found.');
  res.redirect(back(req, 'posts'));
});

router.post('/clients/:id/posts/:postId/delete', async (req, res) => {
  await db.run('DELETE FROM posts WHERE id=$1 AND client_id=$2', rowId(req.params.postId), req.client.id);
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

router.post('/clients/:id/drafts', async (req, res) => {
  const { d, errors } = readDraft(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'drafts')); }
  await db.run('INSERT INTO drafts (client_id, subreddit, title, body) VALUES ($1,$2,$3,$4)', req.client.id, d.subreddit, d.title, d.body);
  res.flash('success', 'Draft added. The client can now approve or deny it.');
  res.redirect(back(req, 'drafts'));
});

router.post('/clients/:id/drafts/:draftId', async (req, res) => {
  const { d, errors } = readDraft(req.body);
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect(back(req, 'drafts')); }
  const id = rowId(req.params.draftId);
  const old = await db.one('SELECT * FROM drafts WHERE id=$1 AND client_id=$2', id, req.client.id);
  if (!old) { res.flash('error', 'Draft not found.'); return res.redirect(back(req, 'drafts')); }
  // Changing the content sends the draft back to the client for a fresh decision.
  const changed = old.subreddit !== d.subreddit || old.title !== d.title || old.body !== d.body;
  await db.run(`UPDATE drafts SET subreddit=$1, title=$2, body=$3,
      status = CASE WHEN $4 THEN 'pending' ELSE status END,
      decided_at = CASE WHEN $4 THEN NULL ELSE decided_at END
    WHERE id=$5 AND client_id=$6`, d.subreddit, d.title, d.body, changed, id, req.client.id);
  res.flash('success', changed && old.status !== 'pending' ? 'Draft updated and sent back to the client for review.' : 'Draft updated.');
  res.redirect(back(req, 'drafts'));
});

router.post('/clients/:id/drafts/:draftId/delete', async (req, res) => {
  await db.run('DELETE FROM drafts WHERE id=$1 AND client_id=$2', rowId(req.params.draftId), req.client.id);
  res.flash('success', 'Draft deleted.');
  res.redirect(back(req, 'drafts'));
});

// Turn an approved draft into a live post (views start at 0) and remove the draft.
router.post('/clients/:id/drafts/:draftId/publish', async (req, res) => {
  const url = clean(req.body.url, 500);
  const moved = await db.tx(async (t) => {
    const d = await t.one("DELETE FROM drafts WHERE id=$1 AND client_id=$2 AND status='approved' RETURNING *",
      rowId(req.params.draftId), req.client.id);
    if (!d) return false;
    await t.run('INSERT INTO posts (client_id, subreddit, title, body, url, views) VALUES ($1,$2,$3,$4,$5,0)',
      req.client.id, d.subreddit, d.title, d.body, /^https?:\/\//i.test(url) ? url : '');
    return true;
  });
  if (!moved) { res.flash('error', 'Only approved drafts can be moved to live posts.'); return res.redirect(back(req, 'drafts')); }
  res.flash('success', 'Draft moved to live posts. Update its views as they come in.');
  res.redirect(back(req, 'posts'));
});

/* ---------- admin settings ---------- */

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings' }));

router.post('/settings/username', async (req, res) => {
  const admin = await db.one('SELECT * FROM admins WHERE id = $1', req.session.userId);
  if (!(await auth.checkPassword(String(req.body.current || ''), admin.password_hash))) {
    res.flash('error', 'Current password is incorrect.');
    return res.redirect('/admin/settings');
  }
  const username = clean(req.body.username, 60);
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) {
    res.flash('error', 'Username must be 3–60 characters: letters, numbers, dots, dashes or underscores.');
    return res.redirect('/admin/settings');
  }
  if (await db.one('SELECT 1 FROM admins WHERE lower(username) = lower($1) AND id <> $2', username, admin.id)) {
    res.flash('error', 'That username is already taken.');
    return res.redirect('/admin/settings');
  }
  await db.run('UPDATE admins SET username = $1 WHERE id = $2', username, admin.id);
  res.flash('success', `Username changed to ${username}. Use it next time you sign in.`);
  res.redirect('/admin/settings');
});

router.post('/settings/password', async (req, res) => {
  const admin = await db.one('SELECT * FROM admins WHERE id = $1', req.session.userId);
  if (!(await auth.checkPassword(String(req.body.current || ''), admin.password_hash))) {
    res.flash('error', 'Current password is incorrect.');
    return res.redirect('/admin/settings');
  }
  const err = auth.validatePassword(req.body.password);
  if (err || req.body.password !== req.body.confirm) {
    res.flash('error', err || 'New passwords do not match.');
    return res.redirect('/admin/settings');
  }
  await db.run('UPDATE admins SET password_hash = $1 WHERE id = $2', await auth.hashPassword(req.body.password), admin.id);
  await auth.destroyUserSessions('admin', admin.id);
  await auth.createSession(res, 'admin', admin.id);
  res.flash('success', 'Password changed.');
  res.redirect('/admin/settings');
});

module.exports = router;
