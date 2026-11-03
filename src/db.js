// Postgres database. In production this is Neon (set DATABASE_URL).
// Without DATABASE_URL (local tryout and tests) it uses PGlite, an in-process
// Postgres stored in ./data/pglite, so nothing extra needs installing.
const path = require('path');

const SCHEMA = `
BEGIN;
-- Stops two servers starting at once from racing to create tables.
SELECT pg_advisory_xact_lock(724001);
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS admins_username ON admins (lower(username));

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  logo_version TEXT,
  plan_views BIGINT NOT NULL DEFAULT 0,
  price_cents BIGINT NOT NULL DEFAULT 0,
  billing_period TEXT NOT NULL DEFAULT 'month',
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_username ON clients (lower(username));

-- Logos live in their own table so client lists never load image bytes.
CREATE TABLE IF NOT EXISTS client_logos (
  client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  views BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  views_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_client ON posts (client_id);

CREATE TABLE IF NOT EXISTS drafts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  client_note TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_client ON drafts (client_id);

-- Small key/value store for one-off app settings.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','client')),
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

COMMIT;
`;

const toNumber = (v) => (v === null ? null : Number(v));

// Each driver exposes the same three calls: query, transaction, close.
function pgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, toNumber); // BIGINT and COUNT(*) as plain numbers
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10000 });
  const wrap = (c) => ({ query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, count: r.rowCount }; } });
  return {
    ...wrap(pool),
    multi: (sql) => pool.query(sql),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap(c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

function pgliteDriver(dir) {
  let lite;
  const get = async () => {
    if (!lite) {
      const { PGlite, types } = await import('@electric-sql/pglite');
      lite = new PGlite(dir, { parsers: { [types.INT8]: toNumber } });
    }
    return lite;
  };
  const wrap = (c) => ({ query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, count: r.affectedRows ?? 0 }; } });
  return {
    query: async (sql, params) => wrap(await get()).query(sql, params),
    multi: async (sql) => (await get()).exec(sql),
    transaction: async (fn) => (await get()).transaction((tx) => fn(wrap(tx))),
    close: async () => { if (lite) await lite.close(); },
  };
}

const driver = process.env.DATABASE_URL
  ? pgDriver(process.env.DATABASE_URL)
  : pgliteDriver(process.env.PGLITE_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pglite'));

// Small helpers so routes read clearly. Use $1, $2… placeholders.
function api(q) {
  return {
    all: async (sql, ...params) => (await q.query(sql, params)).rows,
    one: async (sql, ...params) => (await q.query(sql, params)).rows[0],
    run: async (sql, ...params) => (await q.query(sql, params)).count,
  };
}

let readyPromise;
const db = {
  ...api(driver),
  tx: (fn) => driver.transaction((t) => fn(api(t))),
  close: () => driver.close(),
  // Creates tables on first use. Safe to call many times.
  ready: () => (readyPromise ||= driver.multi(SCHEMA).catch((e) => { readyPromise = null; throw e; })),
};

module.exports = { db };
