// ── FxOrbit strategy library ─────────────────────────────────────────────────
// Saved strategies live on their own (localStorage `fxorbit-strategies`) and
// only ever change when the user says so: analysing a description produces a
// draft, and the draft becomes a library entry — or the active strategy — only
// through an explicit action. The active pointer is mirrored into settings as
// `activeStrategy` / `activeStrategyData` because the Dashboard, Portfolio and
// Signals pages read it from there.

import { TIMEFRAMES } from './marketEngine';
import { loadSettings, loadStrategies, saveSettings, saveStrategies } from './settings';

let seq = 0;
const newId = () => `s-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;
const now = () => Date.now();

const toList = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]))
  .map((x) => String(x).trim())
  .filter(Boolean);

export const ORIGINS = {
  ai: 'AI analysed',
  market: 'Market generated',
  manual: 'Hand written',
  merged: 'Merged',
};

// A rule only counts as naming a timeframe when its line also talks about
// charts or candles — risk phrasing like "exit after 4 hours of stagnation"
// describes a duration, not a timeframe the strategy trades on.
const TF_WORDS = [
  ['1m', /\b(?:1[-\s]?min(?:ute)?s?|one[-\s]?min(?:ute)?s?|m1|1m)\b/i],
  ['5m', /\b(?:5[-\s]?min(?:ute)?s?|five[-\s]?min(?:ute)?s?|m5|5m)\b/i],
  ['15m', /\b(?:15[-\s]?min(?:ute)?s?|fifteen[-\s]?min(?:ute)?s?|m15|15m)\b/i],
  ['1H', /\b(?:1[-\s]?h(?:ou)?rs?|one[-\s]?hour|h1|1h)\b/i],
  ['4H', /\b(?:4[-\s]?h(?:ou)?rs?|four[-\s]?hour|h4|4h)\b/i],
  ['1D', /\b(?:1[-\s]?day|one[-\s]?day|d1|1d)\b/i],
];
const TF_CONTEXT = /chart|timeframe|time[ -]?frame|\btf\b|candle|interval|\bbars?\b/i;

// Reads the timeframes a strategy trades straight out of its own rules, so a
// book saved before the field existed still restricts itself. The narrative
// analysis is skipped on purpose: higher-timeframe filters ("watch the trend
// on the four-hour chart") live there and are context, not execution.
export function detectTimeframes(s) {
  const title = String(s?.title ?? '');
  const rules = [...toList(s?.entryRules), ...toList(s?.riskRules)];
  const hits = TF_WORDS
    .filter(([, re]) => re.test(title) || rules.some((l) => re.test(l) && TF_CONTEXT.test(l)))
    .map(([t]) => t);
  return hits.length ? TIMEFRAMES.filter((t) => hits.includes(t)) : null;
}

// "1m and 5m" / "1m, 5m and 15m" — every user-facing TF sentence reads this way.
export const timeframeLabel = (list) => (list.length > 2
  ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  : list.join(' and '));

// The timeframes a strategy may trade on: an explicit list wins, a record
// without one falls back to its own rule text, and "no restriction found"
// means every timeframe. Always returns a non-empty, ordered subset.
export function allowedTimeframes(s) {
  const explicit = Array.isArray(s?.timeframes)
    ? TIMEFRAMES.filter((t) => s.timeframes.includes(t))
    : detectTimeframes(s);
  return explicit?.length ? explicit : TIMEFRAMES;
}

// One shape for everything the rest of the app touches, so a half-written model
// response or a legacy record can't leak undefined arrays into the UI.
export function normalizeStrategy(s = {}) {
  const stamp = now();
  return {
    id: s.id || newId(),
    title: String(s.title || 'Untitled Strategy').trim(),
    pair: String(s.pair || 'EUR/USD'),
    analysis: toList(s.analysis),
    entryRules: toList(s.entryRules),
    riskRules: toList(s.riskRules),
    origin: ORIGINS[s.origin] ? s.origin : 'manual',
    parents: toList(s.parents),
    timeframes: Array.isArray(s.timeframes)
      ? TIMEFRAMES.filter((t) => s.timeframes.includes(t))
      : (detectTimeframes(s) ?? []),
    armed: !!s.armed,
    simulated: !!s.simulated,
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : stamp,
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : stamp,
  };
}

// Read the library, importing a pre-library active strategy exactly once.
export function loadLibrary() {
  const stored = Array.isArray(loadStrategies()) ? loadStrategies() : [];
  if (stored.length) return stored.map(normalizeStrategy);
  const legacy = loadSettings().activeStrategyData;
  if (!legacy || !legacy.title) return [];
  const imported = normalizeStrategy({ ...legacy, origin: legacy.simulated ? 'ai' : 'manual' });
  saveStrategies([imported]);
  return [imported];
}

export const saveLibrary = (list) => {
  saveStrategies(list);
  return list;
};

export function addStrategy(list, s) {
  const next = normalizeStrategy(s);
  return [next, ...list.filter((x) => x.id !== next.id)];
}

export function updateStrategy(list, id, patch) {
  return list.map((s) => (s.id === id ? normalizeStrategy({ ...s, ...patch, id, createdAt: s.createdAt, updatedAt: now() }) : s));
}

export function removeStrategy(list, id) {
  return list.filter((s) => s.id !== id);
}

export function armStrategy(list, id, on) {
  return list.map((s) => (s.id === id ? { ...s, armed: !!on } : s));
}

export const findStrategy = (list, id) => list.find((s) => s.id === id) ?? null;

const shortTitle = (t) => t.replace(/\s+strategy$/i, '').trim() || t;

// Union merge used on its own when there is no model, and as the fallback when
// the model's merge can't be parsed.
export function mergeStrategies(a, b) {
  const samePair = a.pair === b.pair;
  const union = (x, y, cap = 8) => [...new Set([...x, ...y])].slice(0, cap);
  // Either parent being timeframe-agnostic makes the merge agnostic too: its
  // setups were valid on every chart, so restricting the union would drop them.
  const tfUnion = a.timeframes?.length && b.timeframes?.length
    ? TIMEFRAMES.filter((t) => a.timeframes.includes(t) || b.timeframes.includes(t))
    : [];
  return normalizeStrategy({
    title: `${shortTitle(a.title)} × ${shortTitle(b.title)} Merge`,
    pair: a.pair, // one book trades one pair; a disagreement is noted below
    analysis: [
      `Combines “${a.title}” and “${b.title}”. Setups from either parent are valid;`
      + ' where the two disagree the stricter rule is listed first and the looser one is dropped.',
      a.analysis[0] ?? '',
      b.analysis[0] ?? '',
      samePair ? '' : `Parents target different pairs (${a.pair} and ${b.pair}); this merged book trades ${a.pair} only.`,
    ].filter(Boolean),
    entryRules: union(a.entryRules, b.entryRules),
    riskRules: union(a.riskRules, b.riskRules),
    timeframes: tfUnion,
    origin: 'merged',
    parents: [a.id, b.id],
  });
}

// The active strategy is stored as a pointer plus a settings mirror for the
// pages that read it without knowing about the library.
export function applyActive(list, id) {
  const found = id ? findStrategy(list, id) : null;
  saveSettings(found
    ? { activeStrategyId: found.id, activeStrategy: found.title, activeStrategyData: found }
    : { activeStrategyId: '', activeStrategy: '', activeStrategyData: null });
  return found;
}
