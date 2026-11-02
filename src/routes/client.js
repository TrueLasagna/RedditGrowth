const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const { clean } = require('../helpers');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session?.role === 'client') return res.redirect('/');
  res.render('client/login', { title: 'Client sign in', error: null, username: '' });
});

router.post('/login', (req, res) => {
  const username = clean(req.body.username, 100);
  const password = String(req.body.password || '');
  const key = `client:${req.ip}:${username.toLowerCase()}`;
  const fail = (status, error) => res.status(status).render('client/login', { title: 'Client sign in', username, error });
  if (auth.tooManyAttempts(key)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
  const client = db.prepare('SELECT * FROM clients WHERE username = ?').get(username);
  if (!client || !auth.checkPassword(password, client.password_hash)) {
    auth.recordFailure(key);
    return fail(401, 'Incorrect username or password.');
  }
  if (!client.active) return fail(403, 'This account is inactive. Please contact RedditGrowth.');
  auth.clearFailures(key);
  if (req.session) auth.destroySession(req, res);
  auth.createSession(res, 'client', client.id);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/login');
});

// Everything below: a signed-in, active client. The client id ALWAYS comes from the
// session, never from the URL, so one client can never reach another's data.
router.use((req, res, next) => {
  if (req.session?.role === 'admin' && req.path === '/') return res.redirect('/admin');
  if (req.session?.role !== 'client') return res.redirect('/login');
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.userId);
  if (!client || !client.active) {
    auth.destroySession(req, res);
    return res.redirect('/login');
  }
  req.client = client;
  res.locals.client = client;
  res.locals.pendingCount = db.prepare("SELECT COUNT(*) n FROM drafts WHERE client_id = ? AND status = 'pending'").get(client.id).n;
  next();
});

router.get('/', (req, res) => {
  const posts = db.prepare('SELECT id, subreddit, title, url, views, created_at FROM posts WHERE client_id = ? ORDER BY created_at DESC, id DESC').all(req.client.id);
  const totalViews = posts.reduce((s, p) => s + p.views, 0);
  res.render('client/dashboard', { title: 'Dashboard', posts, totalViews });
});

const FILTERS = ['pending', 'approved', 'denied', 'all'];

router.get('/drafts', (req, res) => {
  const filter = FILTERS.includes(req.query.status) ? req.query.status : 'pending';
  const counts = { pending: 0, approved: 0, denied: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM drafts WHERE client_id = ? GROUP BY status').all(req.client.id)) counts[r.status] = r.n;
  counts.all = counts.pending + counts.approved + counts.denied;
  const drafts = filter === 'all'
    ? db.prepare(`SELECT * FROM drafts WHERE client_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC`).all(req.client.id)
    : db.prepare('SELECT * FROM drafts WHERE client_id = ? AND status = ? ORDER BY created_at DESC, id DESC').all(req.client.id, filter);
  res.render('client/drafts', { title: 'Drafts', drafts, filter, counts });
});

router.post('/drafts/:draftId', (req, res) => {
  const decision = { approve: 'approved', deny: 'denied', pending: 'pending' }[req.body.decision];
  if (!decision) return res.redirect('/drafts');
  const note = clean(req.body.note, 1000);
  const r = db.prepare(`UPDATE drafts SET status = ?, client_note = ?,
      decided_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END
    WHERE id = ? AND client_id = ?`).run(decision, note, decision, Number(req.params.draftId), req.client.id);
  if (r.changes) {
    res.flash('success', { approved: 'Draft approved.', denied: 'Draft denied.', pending: 'Draft moved back to pending.' }[decision]);
  }
  const ret = FILTERS.includes(req.body.return_to) ? req.body.return_to : 'pending';
  res.redirect(`/drafts?status=${ret}`);
});

router.get('/account', (req, res) => res.render('client/account', { title: 'Account' }));

router.post('/account/password', (req, res) => {
  if (!auth.checkPassword(String(req.body.current || ''), req.client.password_hash)) {
    res.flash('error', 'Current password is incorrect.');
    return res.redirect('/account');
  }
  const err = auth.validatePassword(req.body.password);
  if (err || req.body.password !== req.body.confirm) {
    res.flash('error', err || 'New passwords do not match.');
    return res.redirect('/account');
  }
  db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), req.client.id);
  auth.destroyUserSessions('client', req.client.id);
  auth.createSession(res, 'client', req.client.id);
  res.flash('success', 'Password changed.');
  res.redirect('/account');
});

module.exports = router;
