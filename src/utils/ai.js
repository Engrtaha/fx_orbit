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

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml)$/i;

export function fileKind(file) {
  const type = String(file?.type || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('text/') || TEXT_EXT.test(String(file?.name || ''))) return 'text';
  return 'file';
}

// Resolves null on read failure so a bad file never wedges the caller's await.
export function readFile(file, mode = 'dataUrl') {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    if (mode === 'text') r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

export function clipText(text, max = 8000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} more characters clipped]` : s;
}

// Sample evenly spaced frames: models can't take a video part, but they can read
// a few stills from it. Resolves [] when the file can't be decoded in-browser.
export function videoFrames(dataUrl, count = 3, max = 768) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const frames = [];
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(frames);
    };
    // A codec the browser can't seek would otherwise hang the analysis forever.
    timer = setTimeout(finish, 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = finish;
    video.onloadedmetadata = () => {
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) { finish(); return; }
      void (async () => {
        for (let i = 0; i < count; i += 1) {
          if (settled) return;
          const at = Math.min(dur * 0.98, (dur * (i + 0.5)) / count);
          await new Promise((res) => { video.onseeked = res; video.currentTime = at; });
          const w = Math.min(max, video.videoWidth || max);
          const h = Math.max(1, Math.round((w * (video.videoHeight || 1)) / (video.videoWidth || 1)));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(video, 0, 0, w, h);
          frames.push(await downscale(canvas.toDataURL('image/png'), max));
        }
        finish();
      })();
    };
    video.src = dataUrl;
  });
}

// Attachment payload for an OpenAI-compatible chat message: document text goes to
// every model, image parts only to vision-capable ones.
export function attachmentContent(prompt, files, { vision = true } = {}) {
  const docs = [];
  const images = [];
  for (const f of files ?? []) {
    if (f?.text) docs.push(`--- ${f.name} ---\n${clipText(f.text)}`);
    if (!vision) continue;
    if (f?.dataUrl) images.push(f.dataUrl);
    for (const frame of f?.frames ?? []) images.push(frame);
  }
  const text = [prompt, docs.length ? `Attached documents:\n\n${docs.join('\n\n')}` : '']
    .filter(Boolean)
    .join('\n\n');
  return [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

export function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
