// tests/borg-arc/claw-code-rag.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClawCodeRAGClient } from '../../src/borg-arc/adapters/claw-code-rag';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ClawCodeRAGClient', () => {
  const client = new ClawCodeRAGClient('http://localhost:8787');

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('query returns ranked chunks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { text: 'relevant chunk', score: 0.92, source: 'file.ts' },
          { text: 'another chunk', score: 0.85, source: 'other.ts' },
        ],
      }),
    });

    const results = await client.query('how does scheduling work?');
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('stats returns chunk count and phase', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ chunks: 1500, phase: 'ready' }),
    });

    const stats = await client.stats();
    expect(stats.chunks).toBe(1500);
    expect(stats.phase).toBe('ready');
  });

  it('health returns false on connection error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const healthy = await client.health();
    expect(healthy).toBe(false);
  });

  it('query returns empty array on error', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const results = await client.query('test');
    expect(results).toEqual([]);
  });
});
