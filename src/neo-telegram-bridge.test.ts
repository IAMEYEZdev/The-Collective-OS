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

describe('Neo Telegram token isolation', () => {
  it('reads the dedicated Neo token when configured', async () => {
    const config = await loadConfigWith({
      NEO_BOT_TOKEN: 'neo-token',
      TELEGRAM_BOT_TOKEN: 'main-token',
    });

    expect(config.NEO_BOT_TOKEN).toBe('neo-token');
  });

  it('never falls back to TELEGRAM_BOT_TOKEN', async () => {
    const config = await loadConfigWith({
      NEO_BOT_TOKEN: undefined,
      TELEGRAM_BOT_TOKEN: 'main-token',
    });

    expect(config.NEO_BOT_TOKEN).toBe('');
  });

  it('never falls back to an agent activeBotToken', async () => {
    const config = await loadConfigWith({
      NEO_BOT_TOKEN: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    });

    config.setAgentOverrides({
      agentId: 'neo',
      botToken: 'agent-token',
      cwd: process.cwd(),
    });
