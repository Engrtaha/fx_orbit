import { describe, expect, it } from 'vitest';
import {
  parseJsonLoose, aiProviderOf, aiReady, aiAuthHeaders, aiSupportsVision,
  fileKind, clipText, attachmentContent,
} from '../src/utils/ai.js';

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

describe('fileKind', () => {
  it('classifies by mime type first', () => {
    expect(fileKind({ name: 'chart.png', type: 'image/png' })).toBe('image');
    expect(fileKind({ name: 'setup.mp4', type: 'video/mp4' })).toBe('video');
    expect(fileKind({ name: 'notes.dat', type: 'text/plain' })).toBe('text');
  });

  it('falls back to the extension for untyped documents', () => {
    expect(fileKind({ name: 'rules.md', type: '' })).toBe('text');
    expect(fileKind({ name: 'trades.CSV', type: '' })).toBe('text');
    expect(fileKind({ name: 'book.pdf', type: 'application/pdf' })).toBe('file');
  });

  it('treats a missing file as a plain file', () => {
    expect(fileKind(null)).toBe('file');
    expect(fileKind({})).toBe('file');
  });
});

describe('clipText', () => {
  it('keeps short text untouched', () => {
    expect(clipText('buy the dip')).toBe('buy the dip');
    expect(clipText(null)).toBe('');
  });

  it('truncates long text and reports how much was clipped', () => {
    const clipped = clipText('x'.repeat(5000), 20);
    expect(clipped.startsWith('x'.repeat(20))).toBe(true);
    expect(clipped).toContain('4980 more characters clipped');
    expect(clipped.length).toBeLessThan(60);
  });
});

describe('attachmentContent', () => {
  const files = [
    { name: 'chart.png', kind: 'image', dataUrl: 'data:image/png;base64,AAA' },
    { name: 'setup.mp4', kind: 'video', frames: ['data:image/png;base64,BBB', 'data:image/png;base64,CCC'] },
    { name: 'rules.md', kind: 'text', text: 'buy dips above the 21-EMA' },
    { name: 'book.pdf', kind: 'file', unsupported: true },
  ];

  it('sends every image and video frame to a vision model', () => {
    const parts = attachmentContent('Analyze this:', files, { vision: true });
    expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('Analyze this:') });
    expect(parts.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,CCC' } },
    ]);
  });

  it('still forwards document text to a text-only model but drops the pixels', () => {
    const parts = attachmentContent('Analyze this:', files, { vision: false });
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('rules.md');
    expect(parts[0].text).toContain('buy dips above the 21-EMA');
    expect(parts[0].text).not.toContain('base64');
  });

  it('returns just the prompt when nothing readable is attached', () => {
    expect(attachmentContent('Analyze this:', [{ name: 'book.pdf', unsupported: true }], { vision: true }))
      .toEqual([{ type: 'text', text: 'Analyze this:' }]);
    expect(attachmentContent('Analyze this:', null, { vision: true }))
      .toEqual([{ type: 'text', text: 'Analyze this:' }]);
  });
});
