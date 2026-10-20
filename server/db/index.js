// ── FxOrbit PostgreSQL persistence ───────────────────────────────────────────
// One shared connection pool + schema for the two archives the terminal keeps:
//   server/db/news.js         → every news/calendar item the desk has seen
//   server/db/tradeHistory.js → every trade, open and closed
//
// Local setup, once:
//   macOS (Homebrew):  brew install postgresql@17 && brew services start postgresql@17
//                      createdb fxorbit
//   Debian / Ubuntu:   sudo -u postgres psql -c "CREATE ROLE $USER LOGIN"
//                      sudo -u postgres psql -c "CREATE DATABASE fxorbit OWNER $USER"
//
// Connection string: DATABASE_URL, e.g. postgres://user:pass@localhost:5432/fxorbit.
// Without it the bridge connects as the current OS user, no password: through the
// local Unix socket when there is one (Debian/Ubuntu authenticate that by OS user,
// while their TCP localhost demands a password the bridge never has), else over
// TCP localhost (Homebrew trusts it). The bridge stays fully functional when
// Postgres is down — it just runs memory-only and retries the connection on a
// backoff, so restarting the database needs no bridge restart.

import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

const PG_SOCKET_DIRS = ['/var/run/postgresql', '/tmp'];
const socketDir = PG_SOCKET_DIRS.find((d) => fs.existsSync(`${d}/.s.PGSQL.5432`));
const osUser = encodeURIComponent(process.env.USER || 'postgres');

export const DATABASE_URL = process.env.DATABASE_URL
  || (socketDir
    ? `postgres://${osUser}@${encodeURIComponent(socketDir)}/fxorbit`
    : `postgres://${osUser}@localhost:5432/fxorbit`);

const RETRY_MS = 30_000;

const pool = new Pool({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 4000 });
pool.on('error', () => { status = 'down'; }); // idle client died — re-probed on next query

let status = 'unknown';
let ready = false;
let lastAttempt = 0;

export const dbStatus = () => status;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trade_history (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,
  status      TEXT NOT NULL,
  source      TEXT,
  strategy_id TEXT,
  lots        DOUBLE PRECISION,
  entry       DOUBLE PRECISION,
  sl          DOUBLE PRECISION,
  tp          DOUBLE PRECISION,
  "exit"      DOUBLE PRECISION,
  pips        DOUBLE PRECISION,
  pnl         DOUBLE PRECISION,
  exit_reason TEXT,
  note        TEXT,
  opened_at   BIGINT,
  closed_at   BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_history_opened_idx ON trade_history (opened_at DESC);
CREATE INDEX IF NOT EXISTS trade_history_status_idx ON trade_history (status);

CREATE TABLE IF NOT EXISTS news_items (
  id         TEXT PRIMARY KEY,
  kind       TEXT,
  feed       TEXT,
  time       BIGINT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT,
  url        TEXT,
  source     TEXT,
  impact     TEXT,
  sentiment  TEXT,
  confidence INTEGER,
  currencies TEXT[],
  topics     TEXT[],
  currency   TEXT,
  actual     TEXT,
  estimate   TEXT,
  previous   TEXT,
  unit       TEXT,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_items_time_idx ON news_items (time DESC);
CREATE INDEX IF NOT EXISTS news_items_feed_idx ON news_items (feed);
`;

async function rawQuery(text, params) {
  if (status === 'down' && Date.now() - lastAttempt < RETRY_MS) return null;
  lastAttempt = Date.now();
  try {
    const res = await pool.query(text, params);
    status = 'up';
    return res;
  } catch (err) {
    status = 'down';
    console.warn(`[db] PostgreSQL unavailable — ${err.message}`);
    return null;
  }
}

// Creates the tables on first use and again after any outage that dropped them.
async function ensureSchema() {
  if (ready) return true;
  const res = await rawQuery(SCHEMA);
  if (res) {
    ready = true;
    console.log(`[db] PostgreSQL ready — ${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}`);
  }
  return ready;
}

// Returns a pg result, or null when the database is unreachable — callers must
// treat null as "not persisted" rather than an error, so the bridge never 500s
// just because Postgres is stopped.
export async function query(text, params) {
  if (!(await ensureSchema())) return null;
  return rawQuery(text, params);
}

// Rows come back with quoted identifiers for mixed-case columns; callers read
// the lowercase names exactly as declared in the schema above.
export async function initDb() {
  await ensureSchema();
  return status;
}

export async function closeDb() {
  ready = false;
  await pool.end().catch(() => { /* already closed */ });
}
