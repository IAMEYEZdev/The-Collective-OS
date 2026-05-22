/**
 * MCP Watchdog — mid-session disconnect recovery.
 *
 * Background:
 *   Claude Code's MCP client does not respawn stdio MCP servers that die
 *   mid-session (idle-timeout, OS kill, etc). The SDK reports the next tool
 *   call as a disconnect error and the server stays dead until the next
 *   `claude` subprocess launch.
 *
 *   The watchdog catches that error, runs a tiny "wake-up" command that
 *   nudges Claude Code's MCP client into the lazy-reconnect path
 *   (e.g. `uvx --from basic-memory basic-memory --version`), waits for the
 *   handshake to complete, then re-runs the failed turn.
 *
 *   This file owns the registry, dedup, and timing helpers. Wiring into the
 *   retry loop lives in agent.ts (`runAgentWithRetry`).
 */

import { spawn } from 'child_process';

import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface McpWakeupConfig {
  /** Absolute path to the executable. Use process.env overrides where helpful. */
  command: string;
  /** Argv passed to the wake-up executable. Should be a brief, side-effect-free call. */
  args: string[];
}

/**
 * Pluggable spawn implementation. Default uses node's child_process.spawn
 * with detached/ignored stdio so the wake-up exits independently of us.
 * Tests inject a fake to assert call shape without launching real processes.
 */
export type SpawnFn = (cmd: string, args: string[]) => boolean;

// ── Registry ──────────────────────────────────────────────────────────

/**
 * Wake-up commands per MCP server. Keyed by the server name as it appears
 * in `.mcp.json` / `.claude/settings.json` mcpServers map (also the name
 * embedded in SDK error strings: `MCP server "<name>": ...`).
 *
 * Extension: append entries here when other servers exhibit mid-session
 * disconnect. The wake-up should be a brief no-side-effect call (e.g.
 * `--version`) — NOT the server's main launch command.
 */
export const MCP_WAKEUP_REGISTRY: Record<string, McpWakeupConfig> = {
  'basic-memory': {
    command:
      process.env.MCP_BASIC_MEMORY_UVX ||
      'C:\\Users\\windows\\.local\\bin\\uvx.exe',
    args: ['--from', 'basic-memory', 'basic-memory', '--version'],
  },
  'apify': {
    command: process.env.MCP_APIFY_NPX || 'npx',
    args: ['@apify/actors-mcp-server', '--help'],
  },
  'graphiti': {
    command:
      process.env.MCP_GRAPHITI_UV ||
      'C:\\Users\\windows\\.local\\bin\\uv.exe',
    args: ['run', '--directory',
      process.env.MCP_GRAPHITI_DIR || 'C:\\Users\\windows\\graphiti\\mcp_server',
      'main.py', '--help'],
  },
};

// ── Tunables ──────────────────────────────────────────────────────────

/** Cooldown that prevents two near-simultaneous wake-ups for the same server. */
export const WAKEUP_COOLDOWN_MS = 30_000;
/** Default handshake-wait window after triggering a wake-up. */
export const DEFAULT_WAKEUP_WAIT_MS = 12_000;
/**
 * Hard cap on retries for a single mcp_disconnect cascade. Spec is 1 retry;
 * raised cap available via env var, but never above 3.
 */
export const MCP_RETRY_HARD_CAP = Math.min(
  Math.max(parseInt(process.env.MCP_WATCHDOG_MAX_RETRIES || '1', 10) || 1, 1),
  3,
);

/** Internal: per-server timestamp of last wake-up trigger, for dedup. */
const lastWakeup: Map<string, number> = new Map();

// ── Cycle Logger ─────────────────────────────────────────────────────

export interface McpCycleEvent {
  server: string;
  event: 'disconnect' | 'wakeup_triggered' | 'wakeup_success' | 'wakeup_failed';
  timestamp: number;
}

/** Rolling buffer of recent MCP cycle events for pattern analysis. */
const cycleLog: McpCycleEvent[] = [];
const CYCLE_LOG_MAX = 100;

/**
 * Record an MCP lifecycle event. Maintains a rolling buffer of the last
 * CYCLE_LOG_MAX events. Used to detect rapid cycling patterns and provide
 * diagnostics when asked.
 */
export function logCycleEvent(
  server: string,
  event: McpCycleEvent['event'],
): void {
  const entry: McpCycleEvent = { server, event, timestamp: Date.now() };
  cycleLog.push(entry);
  if (cycleLog.length > CYCLE_LOG_MAX) {
    cycleLog.splice(0, cycleLog.length - CYCLE_LOG_MAX);
  }
  logger.info(
    { server, event, cycleLogSize: cycleLog.length },
    'MCP watchdog: cycle event logged',
  );
}

/**
 * Return recent cycle events, optionally filtered by server name.
 * Returns newest-first.
 */
export function getCycleLog(serverName?: string): McpCycleEvent[] {
  const filtered = serverName
    ? cycleLog.filter((e) => e.server === serverName)
    : [...cycleLog];
  return filtered.reverse();
}

/**
 * Detect rapid cycling: returns true if a server has had >= `threshold`
 * disconnect events within `windowMs`. Useful for alerting or backing off.
 */
export function isRapidCycling(
  serverName: string,
  windowMs = 300_000,
  threshold = 5,
): boolean {
  const cutoff = Date.now() - windowMs;
  const recentDisconnects = cycleLog.filter(
    (e) => e.server === serverName && e.event === 'disconnect' && e.timestamp > cutoff,
  );
  return recentDisconnects.length >= threshold;
}

/** Reset the cycle log. Test-only. */
export function _resetCycleLog(): void {
  cycleLog.length = 0;
}

// ── Default spawn implementation ──────────────────────────────────────

const defaultSpawnFn: SpawnFn = (cmd, args) => {
  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', (err) => {
      logger.warn(
        { command: cmd, error: err instanceof Error ? err.message : String(err) },
        'MCP wake-up: child emitted error event (post-spawn)',
      );
    });
    child.unref();
    return true;
  } catch (err) {
    logger.warn(
      { command: cmd, error: err instanceof Error ? err.message : String(err) },
      'MCP wake-up: spawn threw synchronously',
    );
    return false;
  }
};

// ── Public API ────────────────────────────────────────────────────────

/**
 * Trigger the wake-up command for a given MCP server.
 * Fire-and-forget: does NOT await process exit.
 *
 * Returns true when:
 *   - The wake-up was spawned successfully, OR
 *   - The server was woken within the cooldown window (no need to spawn again).
 *
 * Returns false (caller should surface the original error) when:
 *   - The server is unknown to the registry.
 *   - The provided spawn function failed.
 *
 * Never throws. Any unexpected error is logged and treated as a spawn failure.
 */
export function triggerWakeup(
  serverName: string,
  spawnFn: SpawnFn = defaultSpawnFn,
): boolean {
  if (!serverName) {
    logger.warn('MCP watchdog: triggerWakeup called with empty server name');
    return false;
  }

  // Log the disconnect event that triggered this wake-up attempt
  logCycleEvent(serverName, 'disconnect');

  const cfg = MCP_WAKEUP_REGISTRY[serverName];
  if (!cfg) {
    logger.warn(
      { serverName, registered: Object.keys(MCP_WAKEUP_REGISTRY) },
      'MCP watchdog: no wake-up command registered for server',
    );
    return false;
  }

  // Check for rapid cycling — warn but don't block (watchdog should never
  // prevent a recovery attempt, just surface the pattern)
  if (isRapidCycling(serverName)) {
    logger.warn(
      { serverName },
      'MCP watchdog: rapid cycling detected (≥5 disconnects in 5min)',
    );
  }

  const now = Date.now();
  const last = lastWakeup.get(serverName) ?? 0;
  if (now - last < WAKEUP_COOLDOWN_MS) {
    logger.info(
      { serverName, sinceLastWakeMs: now - last },
      'MCP watchdog: wake-up deduped (within cooldown)',
    );
    return true;
  }

  // Wrap the spawn call so a misbehaving spawnFn (test injectable, or a
  // pathological default) cannot bubble up and block the agent.
  let ok = false;
  try {
    ok = spawnFn(cfg.command, cfg.args);
  } catch (err) {
    logger.warn(
      { serverName, error: err instanceof Error ? err.message : String(err) },
      'MCP watchdog: wake-up spawn function threw',
    );
    return false;
  }
  if (!ok) {
    logCycleEvent(serverName, 'wakeup_failed');
    logger.warn(
      { serverName, command: cfg.command },
      'MCP watchdog: wake-up spawn failed',
    );
    return false;
  }

  logCycleEvent(serverName, 'wakeup_triggered');
  lastWakeup.set(serverName, now);
  logger.info(
    { serverName, command: cfg.command, args: cfg.args },
    'MCP watchdog: wake-up triggered',
  );
  return true;
}

/**
 * Sleep for `totalMs`, polling `isInterrupted()` every `pollMs`.
 * Returns immediately with `{ interrupted: true }` if the predicate
 * returns true at any poll boundary.
 *
 * Used during the post-wake-up handshake window so a Layer 2 interrupt
 * (or AbortController abort) takes precedence over the retry — user halt
 * always wins over self-recovery.
 */
export async function waitWithInterrupt(
  totalMs: number,
  isInterrupted: () => boolean,
  pollMs = 500,
): Promise<{ interrupted: boolean }> {
  if (totalMs <= 0) return { interrupted: false };
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    let flagged = false;
    try {
      flagged = !!isInterrupted();
    } catch {
      // Interrupt-check itself is best-effort; failure means "no interrupt".
      flagged = false;
    }
    if (flagged) return { interrupted: true };
    const remaining = totalMs - (Date.now() - start);
    await new Promise<void>((r) =>
      setTimeout(r, Math.min(pollMs, Math.max(remaining, 0))),
    );
  }
  return { interrupted: false };
}

// ── Test-only helpers (still exported but underscore-prefixed) ────────

/** Reset the dedup map. Used by unit tests; not part of the runtime contract. */
export function _resetWakeupState(): void {
  lastWakeup.clear();
}
