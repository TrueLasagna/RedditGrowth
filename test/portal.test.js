// End-to-end tests against a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Uses PGlite in a temp folder, or a real Postgres if TEST_DATABASE_URL is set.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
process.env.DATA_DIR = tmp;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;
process.env.ADMIN_USERNAME = 'boss';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
const app = require('../server');
const { db } = require('../src/db');

let server, base;
before(async () => { await app.ensureSetup(); server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.close(); await db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

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
  a.cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
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
  const pw = (await db.one('SELECT password_hash FROM admins')).password_hash;
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
  assert.equal((await db.one('SELECT plan_views FROM clients WHERE id=$1', otherId)).plan_views, 1500000);
  assert.equal((await db.one('SELECT price_cents FROM clients WHERE id=$1', otherId)).price_cents, 99950);

  await a('POST', `/admin/clients/${acmeId}/posts`, { _csrf: csrf, subreddit: 'r/SaaS', title: 'Acme post', body: 'b', views: '12.5k' });
  await a('POST', `/admin/clients/${otherId}/posts`, { _csrf: csrf, subreddit: 'Coffee', title: 'Secret other post', views: '999' });
  await a('POST', `/admin/clients/${acmeId}/drafts`, { _csrf: csrf, subreddit: 'startups', title: 'Acme draft', body: 'hello' });
  await a('POST', `/admin/clients/${otherId}/drafts`, { _csrf: csrf, subreddit: 'startups', title: 'Other draft', body: 'hello' });

  const post = (await db.one('SELECT * FROM posts WHERE client_id=$1', acmeId));
  assert.equal(post.subreddit, 'SaaS');
  assert.equal(post.views, 12500);
  await a('POST', `/admin/clients/${acmeId}/posts/${post.id}/views`, { _csrf: csrf, views: '20000' });
  assert.equal((await db.one('SELECT views FROM posts WHERE id=$1', post.id)).views, 20000);

  // A post id from another client can't be edited through the wrong workspace.
  const otherPost = (await db.one('SELECT id FROM posts WHERE client_id=$1', otherId));
  await a('POST', `/admin/clients/${acmeId}/posts/${otherPost.id}/views`, { _csrf: csrf, views: '1' });
  assert.equal((await db.one('SELECT views FROM posts WHERE id=$1', otherPost.id)).views, 999);

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
  const mine = (await db.one('SELECT id FROM drafts WHERE client_id=$1', acmeId));
  const theirs = (await db.one('SELECT id FROM drafts WHERE client_id=$1', otherId));
  await c('POST', `/drafts/${mine.id}`, { _csrf: csrf, decision: 'deny', note: 'Tone down' });
  await c('POST', `/drafts/${theirs.id}`, { _csrf: csrf, decision: 'approve' });
  assert.equal((await db.one('SELECT status FROM drafts WHERE id=$1', mine.id)).status, 'denied');
  assert.equal((await db.one('SELECT status FROM drafts WHERE id=$1', theirs.id)).status, 'pending', "can't touch another client's draft");

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

test('logo upload is stored in the database and only shown to its owner', async () => {
  const a = agent(); a.home = '/admin';
  await a('POST', '/admin/login', { username: 'boss', password: 'admin-pass-123' });
  const csrf = await a.csrf();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = async (file, name) => {
    const fd = new FormData(); fd.append('_csrf', csrf); fd.append('logo', new Blob([file]), name);
    return fetch(`${base}/admin/clients/${acmeId}/logo`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: a.cookie() } });
  };
  assert.equal((await upload(Buffer.from('not an image'), 'x.png')).status, 302);
  assert.equal((await db.one('SELECT logo_version FROM clients WHERE id=$1', acmeId)).logo_version, null, 'fake image rejected');
  await upload(png, 'logo.png');
  assert.ok((await db.one('SELECT logo_version FROM clients WHERE id=$1', acmeId)).logo_version);

  const own = agent(); await own('POST', '/login', { username: 'acme', password: 'acme-pass-1' });
  const r = await own('GET', `/logo/${acmeId}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match((await own('GET', '/')).text_, new RegExp(`/logo/${acmeId}\\?v=`));
});

test('approved drafts can be moved to live posts', async () => {
  const a = agent(); a.home = '/admin';
  await a('POST', '/admin/login', { username: 'boss', password: 'admin-pass-123' });
  const csrf = await a.csrf();
  const d = await db.one("SELECT id FROM drafts WHERE client_id=$1 AND status='pending'", otherId);
  assert.equal((await a('POST', `/admin/clients/${otherId}/drafts/${d.id}/publish`, { _csrf: csrf })).headers.get('location'), `/admin/clients/${otherId}?tab=drafts`, 'pending draft refused');
  await db.run("UPDATE drafts SET status='approved' WHERE id=$1", d.id);
  await a('POST', `/admin/clients/${otherId}/drafts/${d.id}/publish`, { _csrf: csrf, url: 'https://reddit.com/r/startups/x' });
  assert.equal(await db.one('SELECT id FROM drafts WHERE id=$1', d.id), undefined);
  assert.ok(await db.one("SELECT id FROM posts WHERE client_id=$1 AND title='Other draft' AND views=0", otherId));
});

test('admin can change their username and password', async () => {
  const a = agent(); a.home = '/admin/settings';
  await a('POST', '/admin/login', { username: 'boss', password: 'admin-pass-123' });
  let csrf = await a.csrf();
  await a('POST', '/admin/settings/username', { _csrf: csrf, username: 'chief', current: 'wrong-pass' });
  assert.ok(await db.one("SELECT 1 FROM admins WHERE username='boss'"), 'wrong password keeps old username');
  await a('POST', '/admin/settings/username', { _csrf: csrf, username: 'chief', current: 'admin-pass-123' });
  assert.ok(await db.one("SELECT 1 FROM admins WHERE username='chief'"));
  await a('POST', '/admin/settings/password', { _csrf: csrf, current: 'admin-pass-123', password: 'new-pass-456', confirm: 'new-pass-456' });
  const b = agent();
  assert.equal((await b('POST', '/admin/login', { username: 'boss', password: 'new-pass-456' })).status, 401);
  assert.equal((await b('POST', '/admin/login', { username: 'chief', password: 'new-pass-456' })).status, 302);
});

test('the client sign-in page also accepts the admin login, with no lockout', async () => {
  const a = agent();
  for (let i = 0; i < 10; i++) assert.equal((await a('POST', '/login', { username: 'chief', password: 'nope' })).status, 401);
  const r = await a('POST', '/login', { username: 'chief', password: 'new-pass-456' });
  assert.equal(r.headers.get('location'), '/admin');
  assert.equal((await a('GET', '/admin')).status, 200);
});
