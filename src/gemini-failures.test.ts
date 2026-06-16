import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({
  GOOGLE_API_KEY: 'test-key-123',
  GOOGLE_API_KEY_SECONDARY: '',
  MEMORY_PROVIDER: 'gemini',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  LOCAL_CHAT_MODEL: 'qwen2.5:3b',
  LOCAL_EMBED_MODEL: 'nomic-embed-text',
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

import {
  classifyGeminiError,
  generateContent,
  setRateLimitFatigueCallback,
  type MemoryOfflineEvent,
} from './gemini.js';

describe('classifyGeminiError', () => {
  it('classifies 403 status as auth', () => {
    expect(classifyGeminiError({ status: 403, message: 'Forbidden' })).toBe('auth');
  });

  it('classifies 401 status as auth', () => {
    expect(classifyGeminiError({ status: 401, message: 'Unauthorized' })).toBe('auth');
  });

  it('classifies PERMISSION_DENIED message as auth', () => {
    expect(
      classifyGeminiError({ message: 'got status: 403 . {"error":{"code":403,"status":"PERMISSION_DENIED"}}' }),
    ).toBe('auth');
  });

  it('classifies API_KEY_INVALID as auth', () => {
    expect(classifyGeminiError({ message: 'API_KEY_INVALID: API key not valid' })).toBe('auth');
  });

  it('classifies 429 as rate-limit', () => {
    expect(classifyGeminiError({ status: 429, message: 'Too many requests' })).toBe('rate-limit');
  });

  it('classifies RESOURCE_EXHAUSTED as rate-limit, not auth', () => {
    expect(classifyGeminiError({ message: 'RESOURCE_EXHAUSTED: quota exceeded' })).toBe('rate-limit');
  });

  it('classifies 503 as capacity', () => {
    expect(classifyGeminiError({ status: 503, message: 'Service Unavailable' })).toBe('capacity');
  });

  it('classifies model overloaded as capacity', () => {
    expect(classifyGeminiError({ message: 'The model is overloaded. Please try again later.' })).toBe('capacity');
  });

  it('classifies timeouts and network errors as capacity (fatigue-counting)', () => {
    expect(classifyGeminiError({ message: 'fetch failed' })).toBe('capacity');
    expect(classifyGeminiError({ message: 'connect ETIMEDOUT 142.250.0.1:443' })).toBe('capacity');
    expect(classifyGeminiError({ message: 'getaddrinfo ENOTFOUND generativelanguage.googleapis.com' })).toBe('capacity');
    expect(classifyGeminiError({ message: 'Request timed out' })).toBe('capacity');
  });

  it('classifies unknown errors as other', () => {
    expect(classifyGeminiError({ status: 500, message: 'Internal error' })).toBe('other');
    expect(classifyGeminiError(new Error('something strange'))).toBe('other');
  });
});

describe('generateContent auth failure latch', () => {
  it('fires offline callback immediately on first 403, latches, re-arms after success', async () => {
    const events: MemoryOfflineEvent[] = [];
    setRateLimitFatigueCallback((e) => events.push(e));

    const authErr = Object.assign(new Error('403 PERMISSION_DENIED'), { status: 403 });

    mockGenerateContent.mockRejectedValueOnce(authErr);
    await expect(generateContent('p1')).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('auth');

    // Second auth failure: latched, no duplicate alert
    mockGenerateContent.mockRejectedValueOnce(authErr);
    await expect(generateContent('p2')).rejects.toThrow();
    expect(events).toHaveLength(1);

    // Success re-arms the latch
    mockGenerateContent.mockResolvedValueOnce({ text: '{"ok":true}' });
    await expect(generateContent('p3')).resolves.toBe('{"ok":true}');

    // Next auth failure alerts again, immediately
    mockGenerateContent.mockRejectedValueOnce(authErr);
    await expect(generateContent('p4')).rejects.toThrow();
    expect(events).toHaveLength(2);
    expect(events[1]!.kind).toBe('auth');
  });
});
