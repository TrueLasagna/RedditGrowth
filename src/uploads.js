const crypto = require('crypto');
const multer = require('multer');
const { db } = require('./db');

// Vercel caps request bodies at 4.5 MB, so 2 MB leaves plenty of room.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 5 },
}).single('logo');

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// Detect the real image type from the file's first bytes, not its name.
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'gif';
  return null;
}

// Logos are stored in the database, one row per client.
async function saveLogo(clientId, buffer) {
  const type = sniffImage(buffer);
  if (!type) throw new Error('Logo must be a PNG, JPG, WebP or GIF image.');
  const version = crypto.randomBytes(8).toString('hex');
  await db.tx(async (t) => {
    await t.run(`INSERT INTO client_logos (client_id, mime, data) VALUES ($1,$2,$3)
      ON CONFLICT (client_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`, clientId, MIME[type], buffer);
    await t.run('UPDATE clients SET logo_version = $1 WHERE id = $2', version, clientId);
  });
}

async function deleteLogo(clientId) {
  await db.tx(async (t) => {
    await t.run('DELETE FROM client_logos WHERE client_id = $1', clientId);
    await t.run('UPDATE clients SET logo_version = NULL WHERE id = $1', clientId);
  });
}

const getLogo = (clientId) => db.one('SELECT mime, data FROM client_logos WHERE client_id = $1', clientId);

module.exports = { logoUpload, saveLogo, deleteLogo, getLogo, MAX_LOGO_BYTES };
