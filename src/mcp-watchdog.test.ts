import { describe, it, expect, beforeEach } from 'vitest';

import {
  triggerWakeup,
  waitWithInterrupt,
  _resetWakeupState,
  WAKEUP_COOLDOWN_MS,
  MCP_WAKEUP_REGISTRY,
  MCP_RETRY_HARD_CAP,
  type SpawnFn,
} from './mcp-watchdog.js';

describe('triggerWakeup', () => {
  beforeEach(() => _resetWakeupState());

  it('returns false for unregistered server name', () => {
    let calls = 0;
    const fakeSpawn: SpawnFn = () => { calls++; return true; };
    expect(triggerWakeup('not-a-real-server', fakeSpawn)).toBe(false);
    expect(calls).toBe(0);
  });

  it('returns false for empty server name', () => {
    let calls = 0;
    const fakeSpawn: SpawnFn = () => { calls++; return true; };
    expect(triggerWakeup('', fakeSpawn)).toBe(false);
    expect(calls).toBe(0);
  });

  it('spawns the registered wake-up command for basic-memory', () => {
    const calls: Array<[string, string[]]> = [];
    const fakeSpawn: SpawnFn = (cmd, args) => { calls.push([cmd, args]); return true; };
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('--version');
    expect(calls[0][1]).toContain('basic-memory');
  });

  it('returns false when the spawn function reports failure', () => {
    const fakeSpawn: SpawnFn = () => false;
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(false);
  });

  it('dedups within the cooldown window without spawning twice', () => {
    let count = 0;
    const fakeSpawn: SpawnFn = () => { count++; return true; };
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(true);
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(true);
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(true);
    expect(count).toBe(1);
  });

  it('does not throw when the spawn function itself throws', () => {
    const fakeSpawn: SpawnFn = () => {
      throw new Error('boom');
    };
    // The contract is "never throws" — caller should see false.
    expect(() => triggerWakeup('basic-memory', fakeSpawn)).not.toThrow();
    // After a thrown spawn we still expect false (no successful trigger).
    // Re-test on a fresh state:
    _resetWakeupState();
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(false);
  });

  it('exposes basic-memory in the registry as the only default entry', () => {
    expect(MCP_WAKEUP_REGISTRY['basic-memory']).toBeDefined();
    expect(Object.keys(MCP_WAKEUP_REGISTRY)).toEqual(['basic-memory']);
  });

  it('cooldown is at least 30 seconds', () => {
    expect(WAKEUP_COOLDOWN_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('hard cap stays within the documented 1..3 range', () => {
    expect(MCP_RETRY_HARD_CAP).toBeGreaterThanOrEqual(1);
    expect(MCP_RETRY_HARD_CAP).toBeLessThanOrEqual(3);
  });
});

describe('waitWithInterrupt', () => {
  it('completes the full wait when no interrupt fires', async () => {
    const start = Date.now();
    const result = await waitWithInterrupt(150, () => false, 30);
    const elapsed = Date.now() - start;
    expect(result.interrupted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it('exits early when the interrupt predicate returns true', async () => {
    let calls = 0;
    const start = Date.now();
    const result = await waitWithInterrupt(2000, () => ++calls >= 2, 30);
    const elapsed = Date.now() - start;
    expect(result.interrupted).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns immediately for a non-positive wait', async () => {
    let called = false;
    const result = await waitWithInterrupt(0, () => { called = true; return true; }, 30);
    expect(result.interrupted).toBe(false);
    expect(called).toBe(false);
  });

  it('treats a thrown interrupt predicate as no-interrupt and continues', async () => {
    const start = Date.now();
    const result = await waitWithInterrupt(120, () => { throw new Error('flag read failed'); }, 30);
    const elapsed = Date.now() - start;
    expect(result.interrupted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });
});
