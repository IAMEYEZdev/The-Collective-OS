import { describe, it, expect, beforeEach } from 'vitest';

import {
  triggerWakeup,
  waitWithInterrupt,
  _resetWakeupState,
  _resetCycleLog,
  WAKEUP_COOLDOWN_MS,
  MCP_WAKEUP_REGISTRY,
  MCP_RETRY_HARD_CAP,
  logCycleEvent,
  getCycleLog,
  isRapidCycling,
  type SpawnFn,
} from './mcp-watchdog.js';

describe('triggerWakeup', () => {
  beforeEach(() => {
    _resetWakeupState();
    _resetCycleLog();
  });

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

  it('spawns the registered wake-up command for apify', () => {
    const calls: Array<[string, string[]]> = [];
    const fakeSpawn: SpawnFn = (cmd, args) => { calls.push([cmd, args]); return true; };
    expect(triggerWakeup('apify', fakeSpawn)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('--help');
    expect(calls[0][1]).toContain('@apify/actors-mcp-server');
  });

  it('spawns the registered wake-up command for graphiti', () => {
    const calls: Array<[string, string[]]> = [];
    const fakeSpawn: SpawnFn = (cmd, args) => { calls.push([cmd, args]); return true; };
    expect(triggerWakeup('graphiti', fakeSpawn)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('--help');
    expect(calls[0][1]).toContain('main.py');
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
    _resetCycleLog();
    expect(triggerWakeup('basic-memory', fakeSpawn)).toBe(false);
  });

  it('exposes all three servers in the registry', () => {
    expect(MCP_WAKEUP_REGISTRY['basic-memory']).toBeDefined();
    expect(MCP_WAKEUP_REGISTRY['apify']).toBeDefined();
    expect(MCP_WAKEUP_REGISTRY['graphiti']).toBeDefined();
    expect(Object.keys(MCP_WAKEUP_REGISTRY).sort()).toEqual(['apify', 'basic-memory', 'graphiti']);
  });

  it('cooldown is at least 30 seconds', () => {
    expect(WAKEUP_COOLDOWN_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('hard cap stays within the documented 1..3 range', () => {
    expect(MCP_RETRY_HARD_CAP).toBeGreaterThanOrEqual(1);
    expect(MCP_RETRY_HARD_CAP).toBeLessThanOrEqual(3);
  });

  it('logs cycle events on successful wake-up', () => {
    const fakeSpawn: SpawnFn = () => true;
    triggerWakeup('basic-memory', fakeSpawn);
    const log = getCycleLog('basic-memory');
    expect(log.length).toBe(2); // disconnect + wakeup_triggered
    expect(log[0].event).toBe('wakeup_triggered');
    expect(log[1].event).toBe('disconnect');
  });

  it('logs disconnect + wakeup_failed on spawn failure', () => {
    const fakeSpawn: SpawnFn = () => false;
    triggerWakeup('basic-memory', fakeSpawn);
    const log = getCycleLog('basic-memory');
    expect(log.length).toBe(2);
    expect(log[0].event).toBe('wakeup_failed');
    expect(log[1].event).toBe('disconnect');
  });
});

describe('cycle logging', () => {
  beforeEach(() => _resetCycleLog());

  it('records events and returns newest-first', () => {
    logCycleEvent('basic-memory', 'disconnect');
    logCycleEvent('basic-memory', 'wakeup_triggered');
    logCycleEvent('apify', 'disconnect');
    const all = getCycleLog();
    expect(all).toHaveLength(3);
    expect(all[0].server).toBe('apify');
    expect(all[2].server).toBe('basic-memory');
  });

  it('filters by server name', () => {
    logCycleEvent('basic-memory', 'disconnect');
    logCycleEvent('apify', 'disconnect');
    logCycleEvent('graphiti', 'disconnect');
    expect(getCycleLog('apify')).toHaveLength(1);
    expect(getCycleLog('apify')[0].server).toBe('apify');
  });

  it('detects rapid cycling', () => {
    // 5 disconnects should trigger rapid cycling detection
    for (let i = 0; i < 5; i++) {
      logCycleEvent('basic-memory', 'disconnect');
    }
    expect(isRapidCycling('basic-memory')).toBe(true);
    expect(isRapidCycling('apify')).toBe(false);
  });

  it('does not flag rapid cycling below threshold', () => {
    for (let i = 0; i < 4; i++) {
      logCycleEvent('basic-memory', 'disconnect');
    }
    expect(isRapidCycling('basic-memory')).toBe(false);
  });

  it('ignores non-disconnect events for rapid cycling', () => {
    for (let i = 0; i < 10; i++) {
      logCycleEvent('basic-memory', 'wakeup_triggered');
    }
    expect(isRapidCycling('basic-memory')).toBe(false);
  });

  it('respects rolling buffer limit', () => {
    for (let i = 0; i < 120; i++) {
      logCycleEvent('basic-memory', 'disconnect');
    }
    expect(getCycleLog().length).toBeLessThanOrEqual(100);
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
