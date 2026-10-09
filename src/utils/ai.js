import { AI_PROVIDERS } from '../data/settings';

export const aiProviderOf = (s) => (s?.aiProvider && AI_PROVIDERS[s.aiProvider] ? s.aiProvider : 'openai');

export function aiReady(s = {}) {
  return AI_PROVIDERS[aiProviderOf(s)].keyRequired ? !!s.aiApiKey : true;
}

export function aiAuthHeaders(s = {}) {
  return AI_PROVIDERS[aiProviderOf(s)].keyRequired && s.aiApiKey
    ? { Authorization: `Bearer ${s.aiApiKey}` }
    : {};
}

// Whether the active provider can accept image parts. Ollama catalogs mostly
// text-only models here, so image flows degrade to simulated instead of 400ing.
export function aiSupportsVision(s = {}) {
  return AI_PROVIDERS[aiProviderOf(s)].vision !== false;
}

export function downscale(dataUrl, max = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
