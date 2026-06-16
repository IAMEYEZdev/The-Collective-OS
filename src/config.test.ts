import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfigWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  return import('./config.js');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('config memory provider selection', () => {
  it('defaults to Gemini embedding space', async () => {
    const config = await loadConfigWith({ MEMORY_PROVIDER: undefined });

    expect(config.MEMORY_PROVIDER).toBe('gemini');
    expect(config.ACTIVE_EMBEDDING_MODEL).toBe('embedding-001');
  });

  it('selects local Ollama embedding space when requested', async () => {
    const config = await loadConfigWith({
      MEMORY_PROVIDER: 'LOCAL',
      OLLAMA_BASE_URL: 'http://ollama.test:11434',
      LOCAL_CHAT_MODEL: 'llama3.1:8b',
    });

    expect(config.MEMORY_PROVIDER).toBe('local');
    expect(config.OLLAMA_BASE_URL).toBe('http://ollama.test:11434');
    expect(config.LOCAL_CHAT_MODEL).toBe('llama3.1:8b');
    expect(config.ACTIVE_EMBEDDING_MODEL).toBe('nomic-embed-text');
  });
});
