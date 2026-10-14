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

// Ollama serves image parts only for models that ship a vision projector, so
// the provider alone can't answer this — the model name has to. Anything not
// listed here stays text-only and its image flows degrade to simulated instead
// of 400ing on an unsupported content part.
export const VISION_MODEL_PATTERNS = [
  /minicpm-?v/i, /minicpm[-\s]?om/i, /-vl\b/i, /vl[-:]\d/i, /llava/i, /moondream/i,
  /pixtral/i, /llama4/i, /gemma3:(4|12|27)b/i, /vision[-\s]?lma/i,
];

export const modelSupportsVision = (model) => VISION_MODEL_PATTERNS.some((re) => re.test(String(model ?? '')));

export function aiSupportsVision(s = {}) {
  if (AI_PROVIDERS[aiProviderOf(s)].vision !== false) return true;
  return modelSupportsVision(s.aiModel);
}

// A bot backend publishes decisions instead of answering prompts, so every
// prompt-driven surface has to check this before it tries to ask it something —
// otherwise the call just 404s and the page shows a network error where a
// deterministic fallback was available.
export const aiSupportsChat = (s = {}) => AI_PROVIDERS[aiProviderOf(s)].chat !== false;

export const aiServesDecisions = (s = {}) => AI_PROVIDERS[aiProviderOf(s)].decisions === true;

// Ollama keeps every model it recently served resident for its keep-alive
// window, so switching models would leave the old one eating RAM next to the
// new one — two models at once on an 8 GB machine. This asks the daemon to
// evict everything it has loaded except the model just selected. Only models
// /api/ps reports as loaded are touched (a keep_alive:0 request to an unloaded
// model would make Ollama load it just to unload it).
export async function unloadOtherOllamaModels(settings) {
  const base = String(settings?.aiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (settings?.aiProvider !== 'ollama' || !/^https?:\/\//.test(base)) return [];
  const root = base.replace(/\/v1$/, '');
  try {
    const res = await fetch(`${root}/api/ps`);
    if (!res.ok) return [];
    const data = await res.json();
    const keep = String(settings.aiModel ?? '').trim();
    const stopped = [];
    for (const m of data?.models ?? []) {
      const name = String(m?.name ?? '');
      if (!name || name === keep) continue;
      try {
        const un = await fetch(`${root}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, keep_alive: 0 }),
        });
        if (un.ok) stopped.push(name);
      } catch { /* daemon went away mid-way — nothing to report */ }
    }
    return stopped;
  } catch {
    return [];
  }
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

// One OpenAI-compatible chat call for every flow in the app. Content parts may
// be a string or the multimodal array built by attachmentContent().
export async function aiChat(settings, messages, { temperature = 0.2 } = {}) {
  const res = await fetch(`${settings.aiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(settings) },
    body: JSON.stringify({ model: settings.aiModel || 'gpt-4o-mini', temperature, messages }),
  });
  if (!res.ok) throw new Error(`AI API responded ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Local models wrap JSON in prose and sometimes emit more than one object, so a
// greedy first-{ to last-} span swallows the chatter between them and fails to
// parse. Walk balanced objects instead and keep the first that is real JSON.
export function parseJsonLoose(text) {
  const str = String(text ?? '');
  const direct = [str.trim(), ...[...str.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim())];
  for (const c of direct) {
    try { return JSON.parse(c); } catch { /* try the next shape */ }
  }
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) { depth = 0; start = -1; continue; }
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(str.slice(start, i + 1)); } catch { start = -1; }
      }
    }
  }
  return null;
}
