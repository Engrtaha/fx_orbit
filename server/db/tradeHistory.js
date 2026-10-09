// ── Trade history (PostgreSQL: public.trade_history) ─────────────────────────
// The terminal's real trade book — every manual, signal, news-desk and strategy
// trade, open or closed. The browser syncs its in-memory book here and reloads
// it on startup, so history survives refreshes instead of being regenerated.

import { query } from './index.js';

const FIELDS = [
  { col: 'id', key: 'id' },
  { col: 'symbol', key: 'symbol' },
  { col: 'side', key: 'side' },
  { col: 'status', key: 'status' },
  { col: 'source', key: 'source' },
  { col: 'strategy_id', key: 'strategyId' },
  { col: 'lots', key: 'lots' },
  { col: 'entry', key: 'entry' },
  { col: 'sl', key: 'sl' },
  { col: 'tp', key: 'tp' },
  { col: '"exit"', key: 'exit' },
  { col: 'pips', key: 'pips' },
  { col: 'pnl', key: 'pnl' },
  { col: 'exit_reason', key: 'exitReason' },
  { col: 'note', key: 'note' },
  { col: 'opened_at', key: 'openedAt' },
  { col: 'closed_at', key: 'closedAt' },
];

// null/undefined/'' stay SQL NULL; a real 0 must never be swallowed into null.
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const str = (v) => (v == null || v === '' ? null : String(v));

// Pure row mapper — one engine trade in, one parameter list out (same order as FIELDS).
export function tradeRow(trade) {
  return FIELDS.map(({ key }) => {
    const v = trade[key];
    if (key === 'id' || key === 'symbol' || key === 'side' || key === 'status') return str(v);
    if (key === 'openedAt' || key === 'closedAt') return int(v);
    if (key === 'strategyId' || key === 'source' || key === 'exitReason' || key === 'note') return str(v);
    return num(v);
  });
}

// Database row → the engine's camelCase trade shape.
export function tradeShape(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    status: row.status,
    source: row.source,
    strategyId: row.strategy_id,
    lots: row.lots,
    entry: row.entry,
    sl: row.sl,
    tp: row.tp,
    exit: row.exit,
    pips: row.pips,
    pnl: row.pnl,
    exitReason: row.exit_reason,
    note: row.note,
    openedAt: row.opened_at == null ? null : Number(row.opened_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
  };
}

function upsertSql(rows) {
  const width = FIELDS.length;
  const cols = FIELDS.map((f) => f.col).join(', ');
  const tuples = rows.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`);
  const updates = FIELDS.filter((f) => f.col !== 'id').map((f) => `${f.col} = EXCLUDED.${f.col}`).join(', ');
  return `INSERT INTO trade_history (${cols}) VALUES ${tuples.join(', ')}
    ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at = now()`;
}

// Returns the number of trades written, or null when the database is unreachable.
export async function saveTrades(trades) {
  const valid = (trades ?? []).filter((t) => t?.id && t.symbol && t.side && t.status);
  if (!valid.length) return 0;
  let stored = 0;
  for (let i = 0; i < valid.length; i += 200) {
    const chunk = valid.slice(i, i + 200);
    const res = await query(upsertSql(chunk), chunk.flatMap(tradeRow));
    if (!res) return stored || null;
    stored += chunk.length;
  }
  return stored;
}

export async function loadTrades({ limit = 500, status = null } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(String(status)); where = ` WHERE status = $${params.length}`; }
  params.push(Math.min(5000, Math.max(1, Number(limit) || 500)));
  const res = await query(
    `SELECT * FROM trade_history${where} ORDER BY opened_at DESC NULLS LAST LIMIT $${params.length}`,
    params,
  );
  return (res?.rows ?? []).map(tradeShape);
}

export async function tradeCount() {
  const res = await query('SELECT count(*)::int AS n FROM trade_history');
  return res?.rows?.[0]?.n ?? 0;
}
