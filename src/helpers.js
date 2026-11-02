function formatViews(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}
const formatNumber = (n) => (Number(n) || 0).toLocaleString('en-US');
const formatMoney = (cents) =>
  '$' + ((Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const PERIODS = { month: 'month', campaign: 'campaign', one_time: 'one-time' };
const PLAN_PRESETS = [250000, 500000, 1000000];

// Accepts "250000", "250k", "1.5m", "1,000,000".
function parseViews(v) {
  if (v === undefined || v === null) return NaN;
  const s = String(v).trim().toLowerCase().replace(/[, _]/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return NaN;
  const mult = m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}
function parseMoneyToCents(v) {
  const s = String(v ?? '').trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
const subredditName = (s) => String(s || '').trim().replace(/^\/?r\//i, '').replace(/\s+/g, '');
const clean = (s, max = 10000) => String(s ?? '').trim().slice(0, max);

module.exports = {
  formatViews, formatNumber, formatMoney, formatDate, PERIODS, PLAN_PRESETS,
  parseViews, parseMoneyToCents, subredditName, clean,
};
