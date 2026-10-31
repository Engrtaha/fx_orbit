// ── FxOrbit Telegram trade alerts ────────────────────────────────────────────
// Pushes each newly booked signal to the trader's own chat through the Bot API.
// The token is the user's own (BotFather) and travels from this browser straight
// to api.telegram.org, the same trust path as the AI key — no proxy, no copy
// anywhere else. Every send is logged so the Telegram page can show what the
// desk delivered and what was refused.

import { loadSettings } from './settings';
import { fmt } from './marketEngine';
import { rrLabel } from '../utils/riskReward';

const API = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 12_000;
const LOG_KEY = 'fxorbit-telegram-log';
const MAX_LOG = 25;

const listeners = new Set();
let entries = null;

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.at === 'number') : [];
  } catch {
    return [];
  }
}

const state = () => (entries ??= loadLog());

function emit() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(state())); } catch { /* storage full/blocked */ }
  listeners.forEach((fn) => fn());
}

export function subscribeTelegram(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function alertLog(limit = 8) {
  return state().slice(0, limit);
}

const tokenOf = (s) => String(s?.telegramToken ?? '').trim();
const chatOf = (s) => String(s?.telegramChatId ?? '').trim();

export const telegramConfigured = (s) => !!tokenOf(s) && !!chatOf(s);
export const telegramReady = (s) => !!s?.telegramEnabled && telegramConfigured(s);

// "123456789:AAh…" — the shape BotFather hands out. A bad shape is worth a hint
// but never a block: Telegram is the authority on whether a token works.
export const looksLikeBotToken = (token) => /^\d+:[\w-]{20,}$/.test(String(token ?? '').trim());

const price = (v, d) => (Number.isFinite(Number(v)) ? fmt(Number(v), Number(d) || 0) : '—');

function expiryLabel(sig) {
  const ms = Number(sig?.expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3600e3;
  return hours >= 1 ? `${+hours.toFixed(1)}h` : `${Math.max(1, Math.round(ms / 60e3))}m`;
}

export function alertText(sig) {
  if (!sig) return '';
  const lines = [
    `FxOrbit signal — ${sig.symbol} ${sig.side}`,
    `Entry ${price(sig.entry, sig.decimals)}`,
    `SL ${price(sig.sl, sig.decimals)} · TP ${price(sig.tp, sig.decimals)}`,
    `${sig.tf} · R:R ${rrLabel(sig.rr)} · confidence ${Math.round(Number(sig.confidence) || 0)}%`,
  ];
  if (sig.strategyRules?.name) lines.push(`Strategy: ${sig.strategyRules.name}`);
  const expires = expiryLabel(sig);
  if (expires) lines.push(`Expires in ${expires}`);
  lines.push('Sent by the FxOrbit desk — not financial advice.');
  return lines.join('\n');
}

// Form-encoded bodies are a "simple" request, so the browser skips the CORS
// preflight that api.telegram.org does not answer. `res.ok` alone is not enough:
// Telegram reports failures as { ok: false, description }.
async function callTelegram(token, method, form) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: form ? 'POST' : 'GET',
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(body?.description || `Telegram HTTP ${res.status}`);
  return body.result;
}

export async function botIdentity(s) {
  const token = tokenOf(s);
  if (!token) throw new Error('Add the bot token first.');
  const me = await callTelegram(token, 'getMe');
  return { username: me?.username ?? '', name: me?.first_name ?? '' };
}

export async function sendTelegram(s, text) {
  const token = tokenOf(s);
  const chatId = chatOf(s);
  if (!token || !chatId) throw new Error('Add both the bot token and the chat ID first.');
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: 'true',
  });
}

// Called by saveSignal() — the one place a new signal is booked. Fire-and-forget:
// a Telegram outage must never hold up the signal book or the tick loop.
export async function notifyNewSignal(sig) {
  const s = loadSettings();
  if (!sig || sig.side === 'WAIT' || !telegramReady(s) || !s.telegramNotifySignals) return null;
  if (state().some((e) => e.signalId === sig.id && e.ok)) return null;

  const text = alertText(sig);
  const entry = { signalId: sig.id, symbol: sig.symbol, side: sig.side, text, at: Date.now(), ok: false };
  try {
    await sendTelegram(s, text);
    entry.ok = true;
  } catch (err) {
    entry.error = String(err?.message ?? err);
  }
  entries = [entry, ...state()].slice(0, MAX_LOG);
  emit();
  return entry;
}

// Backs the page's "Clear log" action.
export function clearAlertLog() {
  entries = [];
  emit();
}
