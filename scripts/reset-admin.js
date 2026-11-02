// Usage: npm run reset-admin -- <username> <new-password>
// Creates the admin if it doesn't exist, otherwise resets its password.
const { db } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/auth');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run reset-admin -- <username> <new-password>');
  process.exit(1);
}
const err = validatePassword(password);
if (err) { console.error(err); process.exit(1); }

const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
  db.prepare("DELETE FROM sessions WHERE role = 'admin' AND user_id = ?").run(existing.id);
  console.log(`Password reset for admin "${username}".`);
} else {
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  console.log(`Admin "${username}" created.`);
}
