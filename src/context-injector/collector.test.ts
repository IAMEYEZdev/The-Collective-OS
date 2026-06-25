import { describe, expect, it, vi } from 'vitest';

import { ContextCollector, CONTEXT_INJECT_TOKEN_BUDGET } from './collector.js';

describe('ContextCollector injected context budget', () => {
  it('keeps newest entries first and caps merged context to the token budget', () => {
    const collector = new ContextCollector();
    const sessionId = 'budget-test';
    const budgetChars = CONTEXT_INJECT_TOKEN_BUDGET * 4;

    vi.useFakeTimers();
    vi.setSystemTime(1000);
    collector.register(sessionId, {
      id: 'old',
      source: 'hive-mind',
      content: 'old-' + 'a'.repeat(budgetChars),
      priority: 'critical',
    });

    vi.setSystemTime(2000);
    collector.register(sessionId, {
      id: 'new',
      source: 'team-activity',
      content: 'new-' + 'b'.repeat(100),
      priority: 'low',
    });

    const pending = collector.getPending(sessionId);

    expect(pending.merged.length).toBeLessThanOrEqual(budgetChars);
    expect(pending.merged.startsWith('new-')).toBe(true);
    expect(pending.entries[0]?.id).toBe('new');

    vi.useRealTimers();
  });
});
