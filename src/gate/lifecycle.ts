/**
 * Decision-Surfacing Gate — Lifecycle Manager
 *
 * Handles gate initialization at bot startup, per-build arm/disarm
 * cycles, and first-week observability logging to hive mind.
 *
 * Go-live authorization: Jason, 2026-06-04
 * "GO-LIVE: APPROVED. Arm the interceptor."
 */

import { loadRegistry, reloadRegistry, type Registry } from './registry.js';
import {
  armInterceptor,
  disarmInterceptor,
  isArmed,
  getInterceptorState,
  type InterceptorState,
} from './action-time.js';
import { type ClearanceSet } from './plan-time.js';

// ── Types ──────────────────────────────────────────────────────────

export interface GateStatus {
  initialized: boolean;
  registryVersion: string | null;
  registryPathCount: number;
  armed: boolean;
  activeBuildId: string | null;
  totalHalts: number;
  totalVerifications: number;
  goLiveTimestamp: string;
  firstWeekMode: boolean;
}

interface BuildSession {
  buildId: string;
  startedAt: string;
  clearanceSet: ClearanceSet;
}

// ── State ──────────────────────────────────────────────────────────

let initialized = false;
let registry: Registry | null = null;
let activeBuild: BuildSession | null = null;
let lifetimeHalts = 0;
let lifetimeVerifications = 0;
const GO_LIVE_TIMESTAMP = '2026-06-04T03:30:00.000Z';

// First-week mode: extra logging, expires 7 days after go-live
const FIRST_WEEK_END = new Date(new Date(GO_LIVE_TIMESTAMP).getTime() + 7 * 24 * 60 * 60 * 1000);

// ── Hive Logging (first-week posture) ─────────────────────────────

type HiveLogger = (action: string, summary: string) => void;
let hiveLog: HiveLogger | null = null;

/**
 * Register a hive logger for first-week observability.
 * Called from bot startup with a function that writes to hive mind.
 */
export function setHiveLogger(logger: HiveLogger): void {
  hiveLog = logger;
}

function logToHive(action: string, summary: string): void {
  if (hiveLog) {
    try {
      hiveLog(action, summary);
    } catch {
      // Hive logging is best-effort, never block gate operations
    }
  }
}

function isFirstWeek(): boolean {
  return new Date() < FIRST_WEEK_END;
}

// ── Initialization ────────────────────────────────────────────────

/**
 * Initialize the gate at bot startup.
 * Loads registry, validates integrity, logs go-live status.
 * Does NOT arm the interceptor -- that happens per-build.
 */
export function initGate(): { ok: boolean; error?: string } {
  try {
    registry = loadRegistry();

    // Validate registry integrity
    if (!registry.version || !registry.path_count) {
      return { ok: false, error: 'Registry loaded but missing version or path_count.' };
    }

    initialized = true;

    logToHive(
      'gate-init',
      `Decision-Surfacing Gate initialized. Registry v${registry.version}, ${registry.path_count} surfaces. ` +
      `First-week mode: ${isFirstWeek() ? 'ACTIVE' : 'expired'}. Go-live: ${GO_LIVE_TIMESTAMP}.`
    );

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Registry load failed: ${msg}` };
  }
}

/** Reload registry (used after registry updates, self-governance). */
export function reloadGateRegistry(): { ok: boolean; error?: string } {
  try {
    registry = reloadRegistry();
    logToHive('gate-registry-reload', `Registry reloaded: v${registry.version}, ${registry.path_count} surfaces.`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Registry reload failed: ${msg}` };
  }
}

// ── Build Lifecycle ───────────────────────────────────────────────

/**
 * Start a gated build session.
 * Arms the interceptor with the provided clearance set.
 * Returns the build session for tracking.
 */
export function startGatedBuild(buildId: string, clearanceSet: ClearanceSet): BuildSession {
  if (!initialized) {
    throw new Error('Gate not initialized. Call initGate() first.');
  }

  armInterceptor(clearanceSet);

  activeBuild = {
    buildId,
    startedAt: new Date().toISOString(),
    clearanceSet,
  };

  if (isFirstWeek()) {
    logToHive(
      'gate-build-start',
      `Build ${buildId} armed. Clearance: ${clearanceSet.clearedSurfaceIds.length} surfaces, ` +
      `fullApproval=${clearanceSet.fullApproval}. Interceptor LIVE.`
    );
  }

  return activeBuild;
}

/**
 * End a gated build session.
 * Disarms the interceptor, logs results, returns final state.
 */
export function endGatedBuild(): InterceptorState {
  const finalState = disarmInterceptor();
  const buildId = activeBuild?.buildId || 'unknown';

  lifetimeHalts += finalState.halts.length;
  lifetimeVerifications += finalState.verifications.length;

  // First-week posture: log every build completion with halt/verify counts
  if (isFirstWeek() || finalState.halts.length > 0) {
    const verifyPassed = finalState.verifications.filter(v => v.exists).length;
    const verifyFailed = finalState.verifications.filter(v => !v.exists).length;

    logToHive(
      'gate-build-end',
      `Build ${buildId} complete. Halts: ${finalState.halts.length}, ` +
      `Verifications: ${finalState.verifications.length} (${verifyPassed} pass, ${verifyFailed} fail). ` +
      `Lifetime: ${lifetimeHalts} halts, ${lifetimeVerifications} verifications.`
    );

    // Log individual halts for first-week inspection
    for (const halt of finalState.halts) {
      logToHive(
        'gate-halt',
        `HALT in build ${buildId}: target="${halt.target}" op=${halt.operation} ` +
        `policy=${halt.policy} reason="${halt.haltReason}"`
      );
    }

    // Log verification failures
    for (const v of finalState.verifications.filter(v => !v.exists)) {
      logToHive(
        'gate-verify-fail',
        `VERIFY FAILED in build ${buildId}: ${v.target} not found on disk after write.`
      );
    }
  }

  activeBuild = null;
  return finalState;
}

// ── Status ────────────────────────────────────────────────────────

/** Get current gate status for reporting/diagnostics. */
export function getGateStatus(): GateStatus {
  const interceptorState = getInterceptorState();
  return {
    initialized,
    registryVersion: registry?.version || null,
    registryPathCount: registry?.path_count || 0,
    armed: isArmed(),
    activeBuildId: activeBuild?.buildId || null,
    totalHalts: lifetimeHalts + interceptorState.halts.length,
    totalVerifications: lifetimeVerifications + interceptorState.verifications.length,
    goLiveTimestamp: GO_LIVE_TIMESTAMP,
    firstWeekMode: isFirstWeek(),
  };
}

/** One-line status string for system prompt injection. */
export function getGateStatusLine(): string {
  if (!initialized) return '[Gate: NOT INITIALIZED]';
  const fw = isFirstWeek() ? ' FIRST-WEEK' : '';
  const armed = isArmed() ? `ARMED build=${activeBuild?.buildId}` : 'STANDBY';
  return `[Gate: v${registry?.version} ${armed}${fw} halts=${lifetimeHalts}]`;
}
