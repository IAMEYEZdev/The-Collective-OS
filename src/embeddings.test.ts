import { describe, expect, it, vi } from 'vitest';

const { mockOllamaEmbedText } = vi.hoisted(() => ({
  mockOllamaEmbedText: vi.fn(),
}));

vi.mock('./config.js', () => ({
  GOOGLE_API_KEY: 'gemini-key',
  MEMORY_PROVIDER: 'local',
}));

vi.mock('./local-llm.js', () => ({
  ollamaEmbedText: mockOllamaEmbedText,
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { cosineSimilarity, embedText } from './embeddings.js';

describe('embedText', () => {
  it('routes embedding requests to Ollama when memory provider is local', async () => {
    mockOllamaEmbedText.mockResolvedValueOnce([0.1, 0.2, 0.3]);

    await expect(embedText('remember this')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(mockOllamaEmbedText).toHaveBeenCalledWith('remember this');
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical non-zero vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for empty, mismatched, or zero-magnitude vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});
