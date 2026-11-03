// ADMIN_RESET replaces the admin login once per username+password pair.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-reset-'));
process.env.DATA_DIR = tmp;
delete process.env.DATABASE_URL;
process.env.ADMIN_USERNAME = 'first';
process.env.ADMIN_PASSWORD = 'first-pass-1';
const auth = require('../src/auth');
const app = require('../server');
const { db } = require('../src/db');
after(async () => { await db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const login = async (u, p) => {
  const a = await db.one('SELECT * FROM admins WHERE lower(username)=lower($1)', u);
  return !!a && auth.checkPassword(p, a.password_hash);
};
// Each setup run is a fresh server start.
const restart = async () => { const s = require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../server')]; await require('../server').ensureSetup(); require.cache[require.resolve('../server')] = s; };

test('ADMIN_RESET applies once, then Settings changes stick', async () => {
  await app.ensureSetup();
  assert.ok(await login('first', 'first-pass-1'));

  process.env.ADMIN_RESET = '1';
  process.env.ADMIN_USERNAME = 'second';
  process.env.ADMIN_PASSWORD = 'second-pass-2';
  await restart();
  assert.ok(await login('second', 'second-pass-2'));
  assert.equal((await db.all('SELECT * FROM admins')).length, 1);

  // Admin changes their password in Settings; a restart must not undo it.
  await db.run('UPDATE admins SET password_hash=$1', await auth.hashPassword('mine-pass-3'));
  await restart();
  assert.ok(await login('second', 'mine-pass-3'));
});
