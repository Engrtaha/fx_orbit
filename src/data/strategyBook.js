// ── FxOrbit strategy library ─────────────────────────────────────────────────
// Saved strategies live on their own (localStorage `fxorbit-strategies`) and
// only ever change when the user says so: analysing a description produces a
// draft, and the draft becomes a library entry — or the active strategy — only
// through an explicit action. The active pointer is mirrored into settings as
// `activeStrategy` / `activeStrategyData` because the Dashboard, Portfolio and
// Signals pages read it from there.

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
