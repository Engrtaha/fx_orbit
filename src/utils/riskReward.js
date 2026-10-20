// ── Strategy rule readers ────────────────────────────────────────────────────
// A strategy's numbers live in its own rule text: its target R:R ("TP at 1:4.5
// risk to reward", "target 4.5R"), how long a trade may sit ("time-stop after 4
// hours"), and whether it trades reversals. Every place that sizes a
// take-profit, a time stop or picks a setup — the signal desk, its engine
// fallback and armed strategies — reads them from here, so a book that says
// 1:4.5 is never traded at the engine's default 2.5.

// A line only counts when it talks about risk/reward or the target: "1:1"
// in "move the stop to break-even at 1:1" is not the book's target.
const RR_CONTEXT = /risk|reward|\br\s*[:/]\s*r\b|\brr\b|ratio|target|take[\s-]*profit|\btp\b/i;
// "1:4.5" / "1/4.5" — the leading 1 must stand alone, so "11:30" is no ratio.
const ONE_TO = /(?:^|[^\d.:])1\s*[:/]\s*(\d+(?:\.\d+)?)(?![\d:])/g;
// "4.5R" / "4.5 R" — a multiple of the risk unit.
const R_MULTIPLE = /(?:^|[^\d.:])(\d+(?:\.\d+)?)\s*r\b(?!\s*[:/])/gi;
// "R:R of 4.5", "risk-reward ratio 3", "RR = 2.5"
const NAMED = /(?:\br\s*[:/]\s*r\b|\brr\b|risk[\s-]*(?:to[\s-]*)?reward(?:[\s-]*ratio)?)\s*(?:of|=|is|at|:|min(?:imum)?|>=|≥)?\s*(\d+(?:\.\d+)?)(?!\s*[:/\d])/gi;

const MIN_RR = 0.5;
const MAX_RR = 20;

const asText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(asText).join('\n');
  if (typeof v === 'object') {
    return [v.rules, v.analysis, v.entryRules, v.riskRules].map(asText).join('\n');
  }
  return String(v);
};

// ── Explicit fields ──────────────────────────────────────────────────────────
// A strategy record carries `rr`, `holdHours` and `setup` as fields the user
// edits. When a record HAS the field it is the answer — null included, meaning
// "use the engine default" — and the rule text is only read for records saved
// before the fields existed (normalizeStrategy fills them in once).
const has = (v, key) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, key);
export const validRr = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= MIN_RR && n <= MAX_RR ? n : null;
};
export const validHoldHours = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 && n <= 720 ? n : null;
};
export const SETUPS = ['reversal', 'trend'];

// The book's final target: a plan that scales out ("partial at 1:2, runner to
// 1:4.5") is aiming for the largest ratio it names. Accepts a strategy record,
// the Signals page's { name, rules } payload or plain rule text. Returns null
// when nothing is named, so callers keep their own default.
export function strategyRewardRisk(strategy) {
  if (has(strategy, 'rr')) return validRr(strategy.rr);
  const lines = asText(strategy).split(/\n|(?<=[.;])\s+/);
  let best = null;
  const take = (raw) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_RR && n <= MAX_RR) best = best == null ? n : Math.max(best, n);
  };
  for (const line of lines) {
    if (!RR_CONTEXT.test(line)) continue;
    for (const m of line.matchAll(ONE_TO)) take(m[1]);
    for (const m of line.matchAll(R_MULTIPLE)) take(m[1]);
    for (const m of line.matchAll(NAMED)) take(m[1]);
  }
  return best;
}

// "1:4.5" — the way traders write it, and the way the user's own rules do.
export const rrLabel = (rr) => (Number.isFinite(Number(rr)) && rr != null ? `1:${+Number(rr).toFixed(2)}` : '—');

// "Time-stop: exit any trade still open after 4 hours of stagnation" → 4h in ms.
// Only lines about exiting/holding count, and only a span introduced as a
// duration ("after 4 hours", "within 2 days"), so "exit on a close below the 15m
// EMA" or "the 4-hour chart" is never read as a hold time.
const HOLD_CONTEXT = /time[\s-]*stop|exit|close|stagnat|still (?:open|flat)|max(?:imum)?\s+hold|hold(?:ing)?\s+(?:time|period|for|max)/i;
const HOLD_SPAN = /\b(?:hold(?:ing)?(?: time| period)?(?: of| for)?|after|within|for|beyond|longer than|more than|over|max(?:imum)?(?: of)?|up to|exceeds?)\s+(\d+(?:\.\d+)?)\s*-?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|sessions?)\b/gi;
const UNIT_MS = { m: 60e3, h: 3600e3, d: 86400e3, s: 8 * 3600e3 };

export function strategyMaxHoldMs(strategy) {
  if (has(strategy, 'holdHours')) {
    const h = validHoldHours(strategy.holdHours);
    return h == null ? null : h * 3600e3;
  }
  let best = null;
  for (const line of asText(strategy).split(/\n|(?<=[.;])\s+/)) {
    if (!HOLD_CONTEXT.test(line)) continue;
    for (const m of line.matchAll(HOLD_SPAN)) {
      const unit = m[2].toLowerCase();
      const key = unit.startsWith('se') ? 's' : unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : 'm';
      const ms = Number(m[1]) * UNIT_MS[key];
      if (ms >= 60e3 && ms <= 30 * 86400e3) best = best == null ? ms : Math.max(best, ms);
    }
  }
  return best;
}

// A book that trades tops and bottoms. A pure trend-following book is not one:
// it only hears about a reversal as a reason, never trades into it. Plain
// "liquidity" is not a tell — trend books talk about "session liquidity" too.
const REVERSAL_BOOK = /revers|sweep|stop[\s-]?run|liquidity\s+(?:grab|raid|hunt)|fade|mean[\s-]?reversion|exhaust|overbought|oversold|counter[\s-]?trend/i;
export const isReversalBook = (strategy) => {
  if (has(strategy, 'setup') && SETUPS.includes(strategy.setup)) return strategy.setup === 'reversal';
  return REVERSAL_BOOK.test(asText(strategy));
};

// What the rule TEXT says, ignoring any explicit fields — how a record saved
// before the fields existed gets them. The setup reads only the title and entry
// rules: the analysis narrates context ("the opposite liquidity pool") and the
// risk rules describe exits, neither says what the book enters on.
export function fieldsFromText(s) {
  const text = { analysis: s?.analysis, entryRules: s?.entryRules, riskRules: s?.riskRules };
  const hold = strategyMaxHoldMs(text);
  return {
    rr: strategyRewardRisk(text),
    holdHours: hold == null ? null : +(hold / 3600e3).toFixed(2),
    setup: REVERSAL_BOOK.test([s?.title, ...(Array.isArray(s?.entryRules) ? s.entryRules : [s?.entryRules])].join('\n'))
      ? 'reversal' : 'trend',
  };
}
