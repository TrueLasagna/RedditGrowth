// One-shot messages carried across a redirect in a short-lived cookie.
const NAME = 'rg_flash';

module.exports = function flash(req, res, next) {
  res.locals.flash = null;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)rg_flash=([^;]+)/);
  if (m) {
    try { res.locals.flash = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { /* ignore */ }
    res.append('Set-Cookie', `${NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
  }
  res.flash = (type, text) => {
    const v = Buffer.from(JSON.stringify({ type, text: String(text).slice(0, 300) })).toString('base64url');
    res.append('Set-Cookie', `${NAME}=${v}; Path=/; HttpOnly; Max-Age=60; SameSite=Lax`);
  };
  next();
};
