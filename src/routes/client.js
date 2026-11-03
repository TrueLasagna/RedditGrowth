const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const { clean } = require('../helpers');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session?.role === 'client') return res.redirect('/');
  res.render('client/login', { title: 'Client Portal', error: null, username: '' });
});

router.post('/login', async (req, res) => {
  const username = clean(req.body.username, 100);
  const password = String(req.body.password || '');
  const key = `client:${req.ip}:${username.toLowerCase()}`;
  const fail = (status, error) => res.status(status).render('client/login', { title: 'Client Portal', username, error });
  if (await auth.tooManyAttempts(key)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
  const client = await db.one('SELECT * FROM clients WHERE lower(username) = lower($1)', username);
  if (!client || !(await auth.checkPassword(password, client.password_hash))) {
    await auth.recordFailure(key);
    return fail(401, 'Incorrect username or password.');
  }
  if (!client.active) return fail(403, 'This account is inactive. Please contact RedditGrowth.');
  await auth.clearFailures(key);
  if (req.session) await auth.destroySession(req, res);
  await auth.createSession(res, 'client', client.id);
  if (Math.random() < 0.1) await auth.purgeExpired();
  res.redirect('/');
});

router.post('/logout', async (req, res) => {
  await auth.destroySession(req, res);
  res.redirect('/login');
});

// Everything below: a signed-in, active client. The client id ALWAYS comes from the
// session, never from the URL, so one client can never reach another's data.
router.use(async (req, res, next) => {
  if (req.session?.role === 'admin' && req.path === '/') return res.redirect('/admin');
  if (req.session?.role !== 'client') return res.redirect('/login');
  const client = await db.one('SELECT * FROM clients WHERE id = $1', req.session.userId);
  if (!client || !client.active) {
    await auth.destroySession(req, res);
    return res.redirect('/login');
  }
  req.client = client;
  res.locals.client = client;
  res.locals.pendingCount = (await db.one("SELECT COUNT(*) n FROM drafts WHERE client_id = $1 AND status = 'pending'", client.id)).n;
  next();
});

router.get('/', async (req, res) => {
  const posts = await db.all('SELECT id, subreddit, title, url, views, created_at FROM posts WHERE client_id = $1 ORDER BY created_at DESC, id DESC', req.client.id);
  const totalViews = posts.reduce((s, p) => s + p.views, 0);
  res.render('client/dashboard', { title: 'Dashboard', posts, totalViews });
});

const FILTERS = ['pending', 'approved', 'denied', 'all'];

router.get('/drafts', async (req, res) => {
  const filter = FILTERS.includes(req.query.status) ? req.query.status : 'pending';
  const counts = { pending: 0, approved: 0, denied: 0 };
  for (const r of await db.all('SELECT status, COUNT(*) n FROM drafts WHERE client_id = $1 GROUP BY status', req.client.id)) counts[r.status] = r.n;
  counts.all = counts.pending + counts.approved + counts.denied;
  const drafts = filter === 'all'
    ? await db.all(`SELECT * FROM drafts WHERE client_id = $1 ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC`, req.client.id)
    : await db.all('SELECT * FROM drafts WHERE client_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC', req.client.id, filter);
  res.render('client/drafts', { title: 'Drafts', drafts, filter, counts });
});

router.post('/drafts/:draftId', async (req, res) => {
  const decision = { approve: 'approved', deny: 'denied', pending: 'pending' }[req.body.decision];
  const draftId = Number(req.params.draftId);
  if (!decision || !Number.isInteger(draftId)) return res.redirect('/drafts');
  const note = clean(req.body.note, 1000);
  const changed = await db.run(`UPDATE drafts SET status = $1, client_note = $2,
      decided_at = CASE WHEN $1 = 'pending' THEN NULL ELSE now() END
    WHERE id = $3 AND client_id = $4`, decision, note, draftId, req.client.id);
  if (changed) {
    res.flash('success', { approved: 'Draft approved.', denied: 'Draft denied.', pending: 'Draft moved back to pending.' }[decision]);
  }
  const ret = FILTERS.includes(req.body.return_to) ? req.body.return_to : 'pending';
  res.redirect(`/drafts?status=${ret}`);
});

router.get('/account', (req, res) => res.render('client/account', { title: 'Account' }));

router.post('/account/password', async (req, res) => {
  if (!(await auth.checkPassword(String(req.body.current || ''), req.client.password_hash))) {
    res.flash('error', 'Current password is incorrect.');
    return res.redirect('/account');
  }
  const err = auth.validatePassword(req.body.password);
  if (err || req.body.password !== req.body.confirm) {
    res.flash('error', err || 'New passwords do not match.');
    return res.redirect('/account');
  }
  await db.run('UPDATE clients SET password_hash = $1 WHERE id = $2', await auth.hashPassword(req.body.password), req.client.id);
  await auth.destroyUserSessions('client', req.client.id);
  await auth.createSession(res, 'client', req.client.id);
  res.flash('success', 'Password changed.');
  res.redirect('/account');
});

module.exports = router;
