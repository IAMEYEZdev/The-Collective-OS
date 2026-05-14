import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from './provider.js';

const state = vi.hoisted(() => ({
  provider: { type: 'codex' as const, model: 'gpt-5.3-codex' },
  dueTasks: [] as Array<{ id: string; prompt: string; schedule: string }>,
  runAgentCalls: [] as unknown[][],
}));

vi.mock('./config.js', () => ({
  AGENT_ID: 'main',
  ALLOWED_CHAT_ID: 'chat-1',
  agentMcpAllowlist: ['filesystem'],
  agentProvider: state.provider,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((_chatId: string, fn: () => Promise<void>) => void fn()),
  },
}));

vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(() => state.dueTasks),
  getSession: vi.fn(() => undefined),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  resetStuckTasks: vi.fn(() => 0),
  claimNextMissionTask: vi.fn(() => null),
  completeMissionTask: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
  getMissionTask: vi.fn(() => null),
}));

vi.mock('./bot.js', () => ({
  formatForTelegram: vi.fn((text: string) => text),
  splitMessage: vi.fn((text: string) => [text]),
}));

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async (...args: unknown[]) => {
    state.runAgentCalls.push(args);
    return { text: 'done', newSessionId: undefined, usage: null };
  }),
}));

import { initScheduler } from './scheduler.js';

describe('scheduler provider selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.dueTasks = [{ id: 'cron-1', prompt: 'daily briefing', schedule: '0 8 * * 1-5' }];
    state.runAgentCalls.length = 0;
  });

  it('runs cron tasks with the current dashboard-selected provider', async () => {
    const send = vi.fn(async () => {});
    initScheduler(send, 'main');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.runAgentCalls).toHaveLength(1);
    expect(state.runAgentCalls[0][8]).toEqual({ type: 'codex', model: 'gpt-5.3-codex' } satisfies ProviderConfig);
  });
});
