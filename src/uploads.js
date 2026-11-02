const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('./db');

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 5 },
}).single('logo');

// Detect the real image type from the file's first bytes, not its name.
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'gif';
  return null;
}

const clientDir = (clientId) => path.join(UPLOAD_DIR, `client-${Number(clientId)}`);

function saveLogo(clientId, buffer) {
  const ext = sniffImage(buffer);
  if (!ext) throw new Error('Logo must be a PNG, JPG, WebP or GIF image.');
  const dir = clientDir(clientId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `logo-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return name;
}

function logoPath(clientId, file) {
  if (!file || !/^logo-[a-f0-9]{16}\.(png|jpg|webp|gif)$/.test(file)) return null;
  return path.join(clientDir(clientId), file);
}

function deleteLogo(clientId, file) {
  const p = logoPath(clientId, file);
  if (p) fs.rmSync(p, { force: true });
}

function deleteClientFiles(clientId) {
  fs.rmSync(clientDir(clientId), { recursive: true, force: true });
}

module.exports = { logoUpload, saveLogo, logoPath, deleteLogo, deleteClientFiles, MAX_LOGO_BYTES };
