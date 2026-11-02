// End-to-end tests against a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USERNAME = 'boss';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
const app = require('../server');
const { db } = require('../src/db');

let server, base;
before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Tiny cookie-keeping browser.
function agent() {
  const jar = {};
  const a = async (method, url, form) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    res.text_ = await res.text();
    return res;
  };
  a.csrf = async () => (await a('GET', a.home)).text_.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
  return a;
}

let acmeId, otherId;

test('admin login rejects bad password and accepts good one', async () => {
  const a = agent();
  assert.equal((await a('POST', '/admin/login', { username: 'boss', password: 'nope' })).status, 401);
  const ok = await a('POST', '/admin/login', { username: 'boss', password: 'admin-pass-123' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin');
  const pw = db.prepare('SELECT password_hash FROM admins').get().password_hash;
  assert.match(pw, /^\$2[aby]\$12\$/, 'admin password is bcrypt-hashed');
});

test('admin creates clients, posts and drafts; CSRF is enforced', async () => {
  const a = agent(); a.home = '/admin';
  await a('POST', '/admin/login', { username: 'boss', password: 'admin-pass-123' });
  const csrf = await a.csrf();
  assert.equal((await a('POST', '/admin/clients', { company_name: 'X', username: 'xx1', password: 'longpassword', plan_choice: '250000', price: '1' })).status, 403, 'no csrf → 403');

  let r = await a('POST', '/admin/clients', { _csrf: csrf, company_name: 'Acme', username: 'acme', password: 'acme-pass-1', plan_choice: '500000', price: '2500', billing_period: 'month' });
  assert.equal(r.status, 302);
  acmeId = Number(r.headers.get('location').match(/clients\/(\d+)/)[1]);
  r = await a('POST', '/admin/clients', { _csrf: csrf, company_name: 'Other Co', username: 'other', password: 'other-pass-1', plan_choice: 'custom', plan_custom: '1.5m', price: '999.50' });
  otherId = Number(r.headers.get('location').match(/clients\/(\d+)/)[1]);
  assert.equal(db.prepare('SELECT plan_views FROM clients WHERE id=?').get(otherId).plan_views, 1500000);
  assert.equal(db.prepare('SELECT price_cents FROM clients WHERE id=?').get(otherId).price_cents, 99950);

  await a('POST', `/admin/clients/${acmeId}/posts`, { _csrf: csrf, subreddit: 'r/SaaS', title: 'Acme post', body: 'b', views: '12.5k' });
  await a('POST', `/admin/clients/${otherId}/posts`, { _csrf: csrf, subreddit: 'Coffee', title: 'Secret other post', views: '999' });
  await a('POST', `/admin/clients/${acmeId}/drafts`, { _csrf: csrf, subreddit: 'startups', title: 'Acme draft', body: 'hello' });
  await a('POST', `/admin/clients/${otherId}/drafts`, { _csrf: csrf, subreddit: 'startups', title: 'Other draft', body: 'hello' });

  const post = db.prepare('SELECT * FROM posts WHERE client_id=?').get(acmeId);
  assert.equal(post.subreddit, 'SaaS');
  assert.equal(post.views, 12500);
  await a('POST', `/admin/clients/${acmeId}/posts/${post.id}/views`, { _csrf: csrf, views: '20000' });
  assert.equal(db.prepare('SELECT views FROM posts WHERE id=?').get(post.id).views, 20000);

  // A post id from another client can't be edited through the wrong workspace.
  const otherPost = db.prepare('SELECT id FROM posts WHERE client_id=?').get(otherId);
  await a('POST', `/admin/clients/${acmeId}/posts/${otherPost.id}/views`, { _csrf: csrf, views: '1' });
  assert.equal(db.prepare('SELECT views FROM posts WHERE id=?').get(otherPost.id).views, 999);

  const overview = await a('GET', '/admin');
  assert.match(overview.text_, /Acme/);
  assert.match(overview.text_, /\$2,500/);
});

test('client sees only their own data and can approve/deny drafts', async () => {
  const c = agent(); c.home = '/';
  assert.equal((await c('GET', '/')).headers.get('location'), '/login');
  await c('POST', '/login', { username: 'ACME', password: 'acme-pass-1' }); // usernames are case-insensitive
  const dash = await c('GET', '/');
  assert.equal(dash.status, 200);
  assert.match(dash.text_, /Acme post/);
  assert.match(dash.text_, /20,000/);
  assert.match(dash.text_, /500K views/);
  assert.doesNotMatch(dash.text_, /Secret other post/);

  const drafts = await c('GET', '/drafts');
  assert.match(drafts.text_, /Acme draft/);
  assert.doesNotMatch(drafts.text_, /Other draft/);

  const csrf = await c.csrf();
  const mine = db.prepare('SELECT id FROM drafts WHERE client_id=?').get(acmeId);
  const theirs = db.prepare('SELECT id FROM drafts WHERE client_id=?').get(otherId);
  await c('POST', `/drafts/${mine.id}`, { _csrf: csrf, decision: 'deny', note: 'Tone down' });
  await c('POST', `/drafts/${theirs.id}`, { _csrf: csrf, decision: 'approve' });
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id=?').get(mine.id).status, 'denied');
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id=?').get(theirs.id).status, 'pending', "can't touch another client's draft");

  // Logos: only the owner (or admin) can load them.
  assert.equal((await c('GET', `/logo/${otherId}`)).status, 404);
  // Clients can't reach admin pages.
  assert.equal((await c('GET', '/admin')).headers.get('location'), '/admin/login');
});

test('deactivated clients are signed out and blocked', async () => {
  const c = agent(); c.home = '/';
  await c('POST', '/login', { username: 'other', password: 'other-pass-1' });
  assert.equal((await c('GET', '/')).status, 200);

  const a = agent(); a.home = '/admin';
  await a('POST', '/admin/login', { username: 'boss', password: 'admin-pass-123' });
  await a('POST', `/admin/clients/${otherId}/status`, { _csrf: await a.csrf(), active: '0' });

  assert.equal((await c('GET', '/')).headers.get('location'), '/login');
  const r = await c('POST', '/login', { username: 'other', password: 'other-pass-1' });
  assert.equal(r.status, 403);
});
