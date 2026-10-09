// ── News archive (PostgreSQL: public.news_items) ─────────────────────────────
// Every item the desk pulls from the news proxy is upserted here, so the
// terminal keeps a permanent record of what was published and when it was
// first seen — independent of the provider's short lookback window.

import { query } from './index.js';

const COLS = [
  'id', 'kind', 'feed', 'time', 'title', 'summary', 'url', 'source', 'impact',
  'sentiment', 'confidence', 'currencies', 'topics', 'currency', 'actual',
  'estimate', 'previous', 'unit',
];

const str = (v) => (v == null || v === '' ? null : String(v));
const int = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).slice(0, 32) : []);

// Pure row mapper — one normalized news item in, one database row out.
export function newsRow(item) {
  return [
    str(item.id),
    str(item.kind),
    str(item.feed),
    int(item.time),
    str(item.title),
    str(item.summary),
    str(item.url),
    str(item.source),
    str(item.impact),
    str(item.sentiment),
    int(item.confidence),
    list(item.currencies),
    list(item.topics),
    str(item.currency),
    str(item.actual),
    str(item.estimate),
    str(item.previous),
    str(item.unit),
  ];
}

function upsertSql(rows) {
  const width = COLS.length;
  const tuples = rows.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`);
  const updates = COLS.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return `INSERT INTO news_items (${COLS.join(', ')}) VALUES ${tuples.join(', ')}
    ON CONFLICT (id) DO UPDATE SET ${updates}`;
  // saved_at is deliberately not updated: it records the first time we saw the item.
}

// Returns the number of items written, or null when the database is unreachable.
export async function saveNewsItems(items) {
  const valid = (items ?? []).filter((i) => i?.id && i.title && i.time);
  if (!valid.length) return 0;
  let stored = 0;
  for (let i = 0; i < valid.length; i += 200) {
    const chunk = valid.slice(i, i + 200);
    const params = chunk.flatMap(newsRow);
    const res = await query(upsertSql(chunk), params);
    if (!res) return stored || null;
    stored += chunk.length;
  }
  return stored;
}

export async function recentNews({ limit = 100, feed = null, currency = null } = {}) {
  const where = [];
  const params = [];
  if (feed) { params.push(String(feed)); where.push(`feed = $${params.length}`); }
  if (currency) { params.push(String(currency).toUpperCase()); where.push(`$${params.length} = ANY(currencies)`); }
  params.push(Math.min(1000, Math.max(1, Number(limit) || 100)));
  const res = await query(
    `SELECT * FROM news_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY time DESC LIMIT $${params.length}`,
    params,
  );
  return res?.rows ?? [];
}

export async function newsCount() {
  const res = await query('SELECT count(*)::int AS n FROM news_items');
  return res?.rows?.[0]?.n ?? 0;
}
