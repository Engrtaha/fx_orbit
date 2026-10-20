// ── FxOrbit settings persistence (localStorage) ─────────────────────────────

export const UNIVERSE = [
  // Majors
  { symbol: 'EUR/USD', base: 'EUR', quote: 'USD', price: 1.08463, decimals: 5, vol: 0.00021, spread: 0.6, pip: 0.0001, group: 'Major' },
  { symbol: 'GBP/USD', base: 'GBP', quote: 'USD', price: 1.27184, decimals: 5, vol: 0.00027, spread: 0.9, pip: 0.0001, group: 'Major' },
  { symbol: 'USD/JPY', base: 'USD', quote: 'JPY', price: 149.328, decimals: 3, vol: 0.00027, spread: 0.7, pip: 0.01,   group: 'Major' },
  { symbol: 'USD/CHF', base: 'USD', quote: 'CHF', price: 0.87942, decimals: 5, vol: 0.00023, spread: 1.0, pip: 0.0001, group: 'Major' },
  { symbol: 'AUD/USD', base: 'AUD', quote: 'USD', price: 0.65387, decimals: 5, vol: 0.00029, spread: 1.1, pip: 0.0001, group: 'Major' },
  { symbol: 'USD/CAD', base: 'USD', quote: 'CAD', price: 1.35921, decimals: 5, vol: 0.00025, spread: 1.2, pip: 0.0001, group: 'Major' },
  { symbol: 'NZD/USD', base: 'NZD', quote: 'USD', price: 0.60841, decimals: 5, vol: 0.00031, spread: 1.5, pip: 0.0001, group: 'Major' },
  // Crosses
  { symbol: 'EUR/GBP', base: 'EUR', quote: 'GBP', price: 0.85264, decimals: 5, vol: 0.00019, spread: 1.4, pip: 0.0001, group: 'Cross' },
  { symbol: 'EUR/JPY', base: 'EUR', quote: 'JPY', price: 161.928, decimals: 3, vol: 0.0003,  spread: 1.6, pip: 0.01,   group: 'Cross' },
  { symbol: 'GBP/JPY', base: 'GBP', quote: 'JPY', price: 189.874, decimals: 3, vol: 0.00042, spread: 2.2, pip: 0.01,   group: 'Cross' },
  { symbol: 'EUR/CHF', base: 'EUR', quote: 'CHF', price: 0.93412, decimals: 5, vol: 0.00017, spread: 1.5, pip: 0.0001, group: 'Cross' },
  { symbol: 'EUR/AUD', base: 'EUR', quote: 'AUD', price: 1.65874, decimals: 5, vol: 0.00034, spread: 1.9, pip: 0.0001, group: 'Cross' },
  { symbol: 'EUR/CAD', base: 'EUR', quote: 'CAD', price: 1.47452, decimals: 5, vol: 0.0003,  spread: 1.9, pip: 0.0001, group: 'Cross' },
  { symbol: 'EUR/NZD', base: 'EUR', quote: 'NZD', price: 1.78345, decimals: 5, vol: 0.0004,  spread: 2.6, pip: 0.0001, group: 'Cross' },
  { symbol: 'GBP/CHF', base: 'GBP', quote: 'CHF', price: 1.11876, decimals: 5, vol: 0.00036, spread: 2.4, pip: 0.0001, group: 'Cross' },
  { symbol: 'GBP/AUD', base: 'GBP', quote: 'AUD', price: 1.94521, decimals: 5, vol: 0.00045, spread: 2.8, pip: 0.0001, group: 'Cross' },
  { symbol: 'GBP/CAD', base: 'GBP', quote: 'CAD', price: 1.72894, decimals: 5, vol: 0.0004,  spread: 2.8, pip: 0.0001, group: 'Cross' },
  { symbol: 'GBP/NZD', base: 'GBP', quote: 'NZD', price: 2.09184, decimals: 5, vol: 0.00052, spread: 3.4, pip: 0.0001, group: 'Cross' },
  { symbol: 'AUD/JPY', base: 'AUD', quote: 'JPY', price: 97.684,  decimals: 3, vol: 0.00034, spread: 1.8, pip: 0.01,   group: 'Cross' },
  { symbol: 'AUD/CAD', base: 'AUD', quote: 'CAD', price: 0.88914, decimals: 5, vol: 0.00022, spread: 1.8, pip: 0.0001, group: 'Cross' },
  { symbol: 'AUD/CHF', base: 'AUD', quote: 'CHF', price: 0.57482, decimals: 5, vol: 0.00024, spread: 2.0, pip: 0.0001, group: 'Cross' },
  { symbol: 'AUD/NZD', base: 'AUD', quote: 'NZD', price: 1.09452, decimals: 5, vol: 0.0002,  spread: 1.9, pip: 0.0001, group: 'Cross' },
  { symbol: 'CAD/JPY', base: 'CAD', quote: 'JPY', price: 109.847, decimals: 3, vol: 0.0003,  spread: 1.9, pip: 0.01,   group: 'Cross' },
  { symbol: 'CAD/CHF', base: 'CAD', quote: 'CHF', price: 0.64691, decimals: 5, vol: 0.00023, spread: 2.2, pip: 0.0001, group: 'Cross' },
  { symbol: 'NZD/JPY', base: 'NZD', quote: 'JPY', price: 90.874,  decimals: 3, vol: 0.00036, spread: 2.2, pip: 0.01,   group: 'Cross' },
  { symbol: 'CHF/JPY', base: 'CHF', quote: 'JPY', price: 169.824, decimals: 3, vol: 0.0005,  spread: 3.0, pip: 0.01,   group: 'Cross' },
  // Exotics
  { symbol: 'USD/TRY', base: 'USD', quote: 'TRY', price: 41.2841, decimals: 4, vol: 0.0016,  spread: 12,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/ZAR', base: 'USD', quote: 'ZAR', price: 17.8421, decimals: 4, vol: 0.0012,  spread: 25,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/MXN', base: 'USD', quote: 'MXN', price: 18.9274, decimals: 4, vol: 0.0009,  spread: 30,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/SGD', base: 'USD', quote: 'SGD', price: 1.30842, decimals: 5, vol: 0.0002,  spread: 10,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/HKD', base: 'USD', quote: 'HKD', price: 7.78412, decimals: 5, vol: 0.00006, spread: 5,   pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/NOK', base: 'USD', quote: 'NOK', price: 10.6248, decimals: 4, vol: 0.0007,  spread: 40,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/SEK', base: 'USD', quote: 'SEK', price: 10.4218, decimals: 4, vol: 0.0007,  spread: 40,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/DKK', base: 'USD', quote: 'DKK', price: 6.86421, decimals: 4, vol: 0.00022, spread: 30,  pip: 0.0001, group: 'Exotic' },
  { symbol: 'USD/PLN', base: 'USD', quote: 'PLN', price: 3.94721, decimals: 4, vol: 0.0008,  spread: 45,  pip: 0.0001, group: 'Exotic' },
  // Metals
  { symbol: 'XAU/USD', base: 'XAU', quote: 'USD', price: 2384.55, decimals: 2, vol: 0.0008, spread: 2.4, pip: 0.1,    group: 'Metal' },
  { symbol: 'XAG/USD', base: 'XAG', quote: 'USD', price: 28.423,  decimals: 3, vol: 0.001,  spread: 2.8, pip: 0.01,   group: 'Metal' },
  // Indices
  { symbol: 'US100',   base: 'NQ',  quote: 'USD', price: 19847.5, decimals: 1, vol: 0.0011, spread: 2.5, pip: 1, group: 'Index' },
  { symbol: 'US500',   base: 'ES',  quote: 'USD', price: 5943.2,  decimals: 1, vol: 0.0008, spread: 1.8, pip: 1, group: 'Index' },
  { symbol: 'US30',    base: 'YM',  quote: 'USD', price: 44820.0, decimals: 1, vol: 0.0007, spread: 3.0, pip: 1, group: 'Index' },
  { symbol: 'GER40',   base: 'FDX', quote: 'EUR', price: 19784.5, decimals: 1, vol: 0.001,  spread: 2.5, pip: 1, group: 'Index' },
  { symbol: 'UK100',   base: 'FT',  quote: 'GBP', price: 8347.2,  decimals: 1, vol: 0.0008, spread: 2.0, pip: 1, group: 'Index' },
  { symbol: 'FR40',    base: 'CAC', quote: 'EUR', price: 7842.6,  decimals: 1, vol: 0.0009, spread: 2.5, pip: 1, group: 'Index' },
  { symbol: 'JP225',   base: 'NK',  quote: 'JPY', price: 40876.0, decimals: 1, vol: 0.0011, spread: 8.0, pip: 1, group: 'Index' },
  { symbol: 'HK50',    base: 'HS',  quote: 'HKD', price: 19842.0, decimals: 1, vol: 0.0013, spread: 6.0, pip: 1, group: 'Index' },
  // Stocks
  { symbol: 'AAPL',  base: 'AAPL',  quote: 'USD', price: 245.32, decimals: 2, vol: 0.0016, spread: 8,  pip: 0.01, group: 'Stock' },
  { symbol: 'NVDA',  base: 'NVDA',  quote: 'USD', price: 184.56, decimals: 2, vol: 0.0024, spread: 9,  pip: 0.01, group: 'Stock' },
  { symbol: 'TSLA',  base: 'TSLA',  quote: 'USD', price: 342.18, decimals: 2, vol: 0.0032, spread: 12, pip: 0.01, group: 'Stock' },
  { symbol: 'MSFT',  base: 'MSFT',  quote: 'USD', price: 521.44, decimals: 2, vol: 0.0013, spread: 8,  pip: 0.01, group: 'Stock' },
  { symbol: 'AMZN',  base: 'AMZN',  quote: 'USD', price: 232.68, decimals: 2, vol: 0.0018, spread: 7,  pip: 0.01, group: 'Stock' },
  { symbol: 'META',  base: 'META',  quote: 'USD', price: 719.84, decimals: 2, vol: 0.0019, spread: 10, pip: 0.01, group: 'Stock' },
  // Crypto — quoted against USD and traded through the same engine, but the
  // tape never shuts: `alwaysOpen` exempts them from the weekend close. Seeds
  // sit near real Coinbase levels; pip/spread are tuned so a volatility stop
  // is never inside the spread on the cheap coins.
  { symbol: 'BTC/USD',  base: 'BTC',  quote: 'USD', price: 81470,  decimals: 1, vol: 0.0011, spread: 28, pip: 1,      group: 'Crypto', alwaysOpen: true },
  { symbol: 'ETH/USD',  base: 'ETH',  quote: 'USD', price: 2432.2, decimals: 2, vol: 0.0013, spread: 45, pip: 0.1,    group: 'Crypto', alwaysOpen: true },
  { symbol: 'SOL/USD',  base: 'SOL',  quote: 'USD', price: 104.53, decimals: 2, vol: 0.0016, spread: 15, pip: 0.01,   group: 'Crypto', alwaysOpen: true },
  { symbol: 'BNB/USD',  base: 'BNB',  quote: 'USD', price: 720.0,  decimals: 2, vol: 0.0012, spread: 20, pip: 0.05,   group: 'Crypto', alwaysOpen: true },
  { symbol: 'XRP/USD',  base: 'XRP',  quote: 'USD', price: 1.3061, decimals: 4, vol: 0.0018, spread: 30, pip: 0.0001, group: 'Crypto', alwaysOpen: true },
  { symbol: 'DOGE/USD', base: 'DOGE', quote: 'USD', price: 0.0803, decimals: 5, vol: 0.0022, spread: 20, pip: 0.00001, group: 'Crypto', alwaysOpen: true },
  { symbol: 'ADA/USD',  base: 'ADA',  quote: 'USD', price: 0.2229, decimals: 4, vol: 0.0018, spread: 12, pip: 0.00005, group: 'Crypto', alwaysOpen: true },
];

export const DEFAULT_ENABLED = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD',
  'NZD/USD', 'EUR/GBP', 'XAU/USD', 'XAG/USD', 'US100', 'US500', 'US30',
  'BTC/USD', 'ETH/USD', 'SOL/USD',
];

const SETTINGS_KEY = 'fxorbit-settings';
const STRATEGIES_KEY = 'fxorbit-strategies';

const defaults = {
  profileName: 'coder nice',
  profileEmail: 'codernice07@gmail.com',
  riskPerTrade: 2,
  defaultPair: 'XAU/USD',
  initialBalance: 100,
  // Epoch ms the current account starts at. Trades closed before it stay in
  // history but no longer move the balance — 0 counts the whole book.
  accountSince: 0,
  activeStrategy: '',
  activeStrategyData: null,
  activeStrategyId: '',
  tvEnabled: false,
  tvBackendUrl: 'http://localhost:5178',
  newsApiKey: '',
  newsProvider: 'rss',
  newsCategory: 'forex',
  aiProvider: 'openai',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiBaseUrl: 'https://api.openai.com/v1',
  pairs: [...DEFAULT_ENABLED],
  autoTrade: [],
};

// localStorage is an outside input, not our own object: a corrupted, hand-edited
// or older record must never override a default with null (pages call
// `settings.profileName.split(...)` and `settings.aiBaseUrl.replace(...)` straight
// away) and must never smuggle in a key the app has no meaning for. Each stored
// value is kept only when it still has the type its default declares.
function sanitizeStored(stored) {
  const src = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
  const out = {};
  for (const key of Object.keys(src)) {
    if (!Object.hasOwn(defaults, key)) continue;
    const want = defaults[key];
    const v = src[key];
    if (want === null) {
      if (v === null || (v && typeof v === 'object' && !Array.isArray(v))) out[key] = v;
    } else if (Array.isArray(want)) {
      if (Array.isArray(v)) out[key] = [...new Set(v.filter((x) => typeof x === 'string' && x))];
    } else if (typeof want === 'boolean') {
      if (typeof v === 'boolean') out[key] = v;
    } else if (typeof want === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    } else if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

export function loadSettings() {
  let stored = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  const next = { ...defaults, ...sanitizeStored(stored) };
  // An instrument list with nothing usable in it would leave the whole terminal
  // without a page to draw, so the saved set is only honoured when it survives.
  // defaultPair is deliberately NOT re-derived here: saveSettings() merges what
  // this returns, so "fixing" it on read would silently overwrite a pair the
  // user switched off and means to switch back on. Pages resolve it themselves.
  if (!next.pairs.length) next.pairs = [...defaults.pairs];
  return next;
}

// The whole account model in one place, so Portfolio and Dashboard can never
// disagree: initial balance is the user's anchor and only realized trade P&L
// (TP/SL hits) moves the balance from it.
export const accountBalance = (s, realizedPnl = 0) =>
  +(((Number(s?.initialBalance) || 0) + (Number(realizedPnl) || 0)).toFixed(2));

// Whether a closed trade belongs to the current account. The archive keeps every
// trade ever booked — including ones sized before risk-based sizing existed, when
// a single stop-out could cost more than a $126 deposit — so the balance, the
// best/worst trade and the win rate read only the trades since the anchor.
export const inAccount = (t, s) => (Number(t?.closedAt) || 0) >= (Number(s?.accountSince) || 0);

const listeners = new Set();

export function subscribeSettings(cb) {
  listeners.add(cb);
  const onStorage = (e) => {
    if (e.key === SETTINGS_KEY) cb(loadSettings());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

function emitSettings() {
  const next = loadSettings();
  listeners.forEach((cb) => cb(next));
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  emitSettings();
  return next;
}

export function resetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
  emitSettings();
  return loadSettings();
}

export function loadStrategies() {
  try {
    return JSON.parse(localStorage.getItem(STRATEGIES_KEY)) ?? [];
  } catch {
    return [];
  }
}

export function saveStrategies(list) {
  localStorage.setItem(STRATEGIES_KEY, JSON.stringify(list));
}

export const GROUPS = ['Major', 'Cross', 'Exotic', 'Metal', 'Index', 'Stock', 'Crypto'];

// AI backends. Both speak the OpenAI /chat/completions shape; Ollama serves it
// at /v1 on the local machine and needs no key.
export const AI_PROVIDERS = {
  openai: {
    label: 'OpenAI-compatible',
    base: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyRequired: true,
    vision: true,
  },
  ollama: {
    label: 'Ollama (local)',
    base: 'http://localhost:11434/v1',
    // The light text model stays the default because it loads in seconds on an
    // 8 GB machine; the two vision presets sit beside it in `models` below.
    // Qwen3-VL is ChartVerse-2B's own base architecture — ChartVerse ships
    // safetensors only and Ollama refuses it as "not GGUF". The `-instruct` tag
    // is deliberate: the plain `qwen3-vl:2b` is a thinking model that spends the
    // whole 4096-token window on reasoning and returns an empty `content`, and
    // neither `thinking:false` nor `/nothink` stops it (verified on this box).
    model: 'llama3.2:latest',
    keyRequired: false,
    // The provider is text-first; only models carrying a projector take images.
    // aiSupportsVision() decides per model name — see src/utils/ai.js.
    vision: false,
    models: [
      { model: 'llama3.2:latest', label: 'Llama 3.2 · 3B', note: 'Fast, text only', vision: false },
      { model: 'moondream:latest', label: 'Moondream · 1.8B', note: 'Reads chart screenshots', vision: true },
      { model: 'qwen3-vl:2b-instruct', label: 'Qwen3-VL · 2B', note: 'Chart reasoning, reads screenshots', vision: true },
    ],
  },
};
