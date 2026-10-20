// ── npm run dev:ai — the local model server for the AI desks ────────────────
// Starts `ollama serve` next to Vite and the bridge so News, Signals and
// Strategies have their local model without a second terminal. It never exits
// on its own: `concurrently -k` takes the whole dev stack down when any one
// process ends, so every "nothing to do" case just reports and idles.
//
//   Ollama already answering (a system service, another terminal) → use it.
//   No ollama binary anywhere                                     → install hint.
//   Otherwise                                                     → run `ollama serve`.
//
// OLLAMA_BIN points at a binary outside PATH; OLLAMA_HOST is honoured as Ollama
// itself reads it. Ollama's per-request access log is dropped — only startup,
// warnings and errors reach the dev console.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = process.env.OLLAMA_HOST || '127.0.0.1:11434';
const BASE = /^https?:\/\//.test(HOST) ? HOST : `http://${HOST}`;
const MODEL = 'llama3.2:latest'; // AI_PROVIDERS.ollama.model in src/data/settings.js
const log = (msg) => console.log(`[ollama] ${msg}`);
const idle = () => setInterval(() => {}, 1 << 30);

async function answering() {
  try {
    const res = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? (await res.json()).version ?? '?' : null;
  } catch {
    return null;
  }
}

function findBinary() {
  const candidates = [
    process.env.OLLAMA_BIN,
    path.join(os.homedir(), '.local/bin/ollama'),
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    '/opt/homebrew/bin/ollama',
  ].filter(Boolean);
  try {
    candidates.unshift(execFileSync('sh', ['-c', 'command -v ollama'], { encoding: 'utf8' }).trim());
  } catch { /* not on PATH */ }
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

async function hasModel() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const names = ((await res.json()).models ?? []).map((m) => m.name);
    return names.length ? names : null;
  } catch {
    return null;
  }
}

async function reportModels() {
  const names = await hasModel();
  if (!names) log(`no models pulled yet — run: ollama pull ${MODEL}`);
  else log(`models: ${names.join(', ')}`);
}

const running = await answering();
if (running) {
  log(`already running at ${BASE} (v${running}) — using it`);
  await reportModels();
  idle();
} else {
  const bin = findBinary();
  if (!bin) {
    log('not installed — the AI desks fall back to their built-in heuristics.');
    log('Install from https://ollama.com/download, then: ollama pull ' + MODEL);
    idle();
  } else {
    log(`starting ${bin} serve on ${BASE}`);
    const child = spawn(bin, ['serve'], { env: { ...process.env, OLLAMA_HOST: HOST }, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim() || line.startsWith('[GIN]')) continue;
        if (/level=(WARN|ERROR)|Listening on|error/i.test(line)) log(line.replace(/^time=\S+\s+/, ''));
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('exit', (code, signal) => {
      log(`ollama serve stopped (${signal ?? `exit ${code}`}) — the AI desks fall back to their heuristics`);
    });
    const stop = () => { child.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    for (let i = 0; i < 40 && !(await answering()); i += 1) await new Promise((r) => setTimeout(r, 250));
    await reportModels();
    idle();
  }
}
