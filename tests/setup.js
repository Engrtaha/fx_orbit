// App data modules read settings through localStorage; tests run in plain node,
// so back it with an in-memory map before any module is imported.
const store = new Map();

globalThis.localStorage = {
  get length() { return store.size; },
  key(i) { return [...store.keys()][i] ?? null; },
  getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
  setItem(k, v) { store.set(String(k), String(v)); },
  removeItem(k) { store.delete(String(k)); },
  clear() { store.clear(); },
};

// Deterministic clock so trade ages and exit timestamps are stable.
export function seedStorage(settings) {
  store.clear();
  localStorage.setItem('fxorbit-settings', JSON.stringify(settings));
  localStorage.setItem('fxorbit-strategies', JSON.stringify([]));
}
