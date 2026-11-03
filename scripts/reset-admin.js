// Usage: npm run reset-admin -- <username> <new-password>
// Creates the admin if it doesn't exist, otherwise resets its password.
// Uses DATABASE_URL if set (your Neon database), otherwise the local test database.
const { db } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/auth');

(async () => {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: npm run reset-admin -- <username> <new-password>');
    process.exit(1);
  }
  const err = validatePassword(password);
  if (err) { console.error(err); process.exit(1); }
  await db.ready();
  const hash = await hashPassword(password);
  const existing = await db.one('SELECT id FROM admins WHERE lower(username) = lower($1)', username);
  if (existing) {
    await db.run('UPDATE admins SET password_hash = $1 WHERE id = $2', hash, existing.id);
    await db.run("DELETE FROM sessions WHERE role = 'admin' AND user_id = $1", existing.id);
    console.log(`Password reset for admin "${username}".`);
  } else {
    await db.run('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', username, hash);
    console.log(`Admin "${username}" created.`);
  }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
