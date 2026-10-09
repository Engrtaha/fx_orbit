import { describe, expect, it } from 'vitest';
import { parseJsonLoose, aiProviderOf, aiReady, aiAuthHeaders, aiSupportsVision } from '../src/utils/ai.js';

describe('parseJsonLoose', () => {
  it('parses a plain JSON object', () => {
    expect(parseJsonLoose('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses JSON fenced in a markdown block', () => {
    const text = 'Here is the result:\n```json\n{"impact":"high","confidence":80}\n```\nHope that helps.';
    expect(parseJsonLoose(text)).toEqual({ impact: 'high', confidence: 80 });
  });

  it('parses JSON embedded in surrounding prose', () => {
    expect(parseJsonLoose('Sure! {"side":"SELL"} — done.')).toEqual({ side: 'SELL' });
  });

  it('returns null when no object is present', () => {
    expect(parseJsonLoose('no structure here')).toBeNull();
  });

  it('returns null for malformed JSON inside braces', () => {
    expect(parseJsonLoose('{side: SELL}')).toBeNull();
    expect(parseJsonLoose('{"a": }')).toBeNull();
  });
});

describe('ai provider helpers', () => {
  it('resolves the provider with openai as the default', () => {
    expect(aiProviderOf({ aiProvider: 'ollama' })).toBe('ollama');
    expect(aiProviderOf({ aiProvider: 'bogus' })).toBe('openai');
    expect(aiProviderOf({})).toBe('openai');
  });

  it('requires a key only for the openai provider', () => {
    expect(aiReady({ aiProvider: 'openai', aiApiKey: 'sk-1' })).toBe(true);
    expect(aiReady({ aiProvider: 'openai', aiApiKey: '' })).toBe(false);
    expect(aiReady({ aiProvider: 'ollama', aiApiKey: '' })).toBe(true);
  });

  it('sends an Authorization header only when a key is required and set', () => {
    expect(aiAuthHeaders({ aiProvider: 'openai', aiApiKey: 'sk-1' }))
      .toEqual({ Authorization: 'Bearer sk-1' });
    expect(aiAuthHeaders({ aiProvider: 'openai', aiApiKey: '' })).toEqual({});
    expect(aiAuthHeaders({ aiProvider: 'ollama', aiApiKey: '' })).toEqual({});
    expect(aiAuthHeaders({ aiProvider: 'ollama', aiApiKey: 'ignored' })).toEqual({});
  });

  it('marks ollama as text-only and keeps openai vision-capable', () => {
    expect(aiSupportsVision({ aiProvider: 'ollama' })).toBe(false);
    expect(aiSupportsVision({ aiProvider: 'openai' })).toBe(true);
    expect(aiSupportsVision({ aiProvider: 'bogus' })).toBe(true);
    expect(aiSupportsVision({})).toBe(true);
  });
});
