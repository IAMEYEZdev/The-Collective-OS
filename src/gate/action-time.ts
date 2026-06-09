/**
 * Decision-Surfacing Gate — Action-Time Interceptor (Step 3)
 *
 * Wraps every mutating tool call. For each write operation:
 * 1. Extract target path/action
 * 2. Classify against registry
 * 3. Check clearance set (from plan-time)
 * 4. GATE policy + not cleared = HALT
 * 5. VERIFY policy = ALLOW + post-write confirmation
 * 6. Ungoverned = ALLOW
 *
 * Exactly-once composition:
 * - Plan-time gates declarations (enters clearance set after ruling)
 * - Action-time gates misses (surfaces not declared at plan-time)
 * - Neither layer duplicates the other
 */

import fs from 'fs';
import {
  classifyPath,
  classifyAction,
  extractTargetsWithUncertainty,
  type Classification,
  type GatePolicy,
} from './registry.js';
import { type ClearanceSet, isCleared } from './plan-time.js';

// ── Types ──────────────────────────────────────────────────────────

export type InterceptVerdict =
  | { action: 'ALLOW'; reason: string }
  | { action: 'ALLOW_VERIFY'; reason: string; verifyPath: string }
  | { action: 'HALT'; reason: string; ledgerEntry: SupplementalLedgerEntry };

export interface SupplementalLedgerEntry {
  target: string;
  operation: string;
  classification: Classification;
  policy: GatePolicy | 'IRREVERSIBLE' | 'UNCERTAIN';
  timestamp: string;
  haltReason: string;
}

export interface VerifyResult {
  target: string;
  exists: boolean;
  timestamp: string;
  sizeBytes?: number;
}

export interface InterceptorState {
  clearanceSet: ClearanceSet | null;
  halts: SupplementalLedgerEntry[];
  verifications: VerifyResult[];
  armed: boolean;
}

// ── Interceptor State ──────────────────────────────────────────────

let state: InterceptorState = {
  clearanceSet: null,
  halts: [],
  verifications: [],
  armed: false,
};

/**
 * Arm the interceptor with a clearance set from plan-time.
 * Until armed, the interceptor is inactive (bootstrap rule).
 */
export function armInterceptor(clearanceSet: ClearanceSet): void {
  state = {
    clearanceSet,
    halts: [],
    verifications: [],
    armed: true,
  };
}

/** Disarm the interceptor (end of build or reset). */
export function disarmInterceptor(): InterceptorState {
  const finalState = { ...state };
  state = {
    clearanceSet: null,
    halts: [],
    verifications: [],
    armed: false,
  };
  return finalState;
}

/** Check if interceptor is currently armed. */
export function isArmed(): boolean {
  return state.armed;
}

/** Get current interceptor state (for reporting). */
export function getInterceptorState(): Readonly<InterceptorState> {
  return state;
}

// ── Intercept Logic ────────────────────────────────────────────────

/**
 * Intercept a file write operation.
 * This is the primary gate: called before any Write/Edit lands on disk.
 */
export function interceptWrite(
  targetPath: string,
  operation: 'write' | 'edit' | 'delete'
): InterceptVerdict {
  if (!state.armed) {
    return { action: 'ALLOW', reason: 'Interceptor not armed (bootstrap or disarmed).' };
  }

  const classification = classifyPath(targetPath);

  // UNCERTAIN: path unclassifiable, default-gated per C1
  if (!classification.governed && classification.uncertain) {
    const halt: SupplementalLedgerEntry = {
      target: targetPath,
      operation,
      classification,
      policy: 'UNCERTAIN',
      timestamp: new Date().toISOString(),
      haltReason: `UNCERTAIN: ${classification.reason}. Default-gated per C1 rule.`,
    };
    state.halts.push(halt);
    return {
      action: 'HALT',
      reason: `HALT: path unclassifiable. ${classification.reason}`,
      ledgerEntry: halt,
    };
  }

  // Ungoverned (known-safe): allow
  if (!classification.governed) {
    return { action: 'ALLOW', reason: `Path ungoverned: ${targetPath}` };
  }

  const { entry, policy } = classification;

  // VERIFY policy: allow but schedule post-write verification
  if (policy === 'VERIFY') {
    return {
      action: 'ALLOW_VERIFY',
      reason: `VERIFY surface: ${entry.id}. Post-write confirmation required.`,
      verifyPath: targetPath,
    };
  }

  // GATE policy: check clearance set
  if (state.clearanceSet && isCleared(targetPath, state.clearanceSet)) {
    return {
      action: 'ALLOW',
      reason: `Cleared by plan-time ruling: ${entry.id}`,
    };
  }

  // GATE policy, NOT cleared: HALT
  const halt: SupplementalLedgerEntry = {
    target: targetPath,
    operation,
    classification,
    policy: 'GATE',
    timestamp: new Date().toISOString(),
    haltReason: `Governed surface "${entry.id}" not in clearance set. Under-declaration or emergent dependency.`,
  };
  state.halts.push(halt);

  return {
    action: 'HALT',
    reason: `HALT: governed surface "${entry.id}" (${policy}) not cleared at plan-time.`,
    ledgerEntry: halt,
  };
}

/**
 * Intercept a Bash command.
 * Extracts targets and checks both path classification and irreversible action patterns.
 */
export function interceptBash(command: string): InterceptVerdict {
  if (!state.armed) {
    return { action: 'ALLOW', reason: 'Interceptor not armed.' };
  }

  // Check irreversible action patterns first
  const actionResult = classifyAction(command);
  if (actionResult) {
    // Check if this specific action type is in clearance set
    if (state.clearanceSet && state.clearanceSet.clearedSurfaceIds.includes(actionResult.action.id)) {
      return {
        action: 'ALLOW',
        reason: `Irreversible action "${actionResult.action.id}" cleared by plan-time ruling.`,
      };
    }

    const halt: SupplementalLedgerEntry = {
      target: command,
      operation: 'bash',
      classification: { governed: false },
      policy: 'IRREVERSIBLE',
      timestamp: new Date().toISOString(),
      haltReason: `Irreversible action detected: ${actionResult.action.id} (${actionResult.action.severity}). Not in clearance set.`,
    };
    state.halts.push(halt);

    return {
      action: 'HALT',
      reason: `HALT: irreversible action "${actionResult.action.id}" [${actionResult.action.severity}].`,
      ledgerEntry: halt,
    };
  }

  // Extract file targets from command with uncertainty detection
  const extractResult = extractTargetsWithUncertainty(command);

  // UNCERTAIN: write-capable command but targets unextractable, default-gated per C1
  if (extractResult.uncertain) {
    const halt: SupplementalLedgerEntry = {
      target: command,
      operation: 'bash',
      classification: { governed: false, uncertain: true, reason: extractResult.uncertainReason || 'Opaque command' },
      policy: 'UNCERTAIN',
      timestamp: new Date().toISOString(),
      haltReason: `UNCERTAIN: ${extractResult.uncertainReason}. Default-gated per C1 rule.`,
    };
    state.halts.push(halt);

    return {
      action: 'HALT',
      reason: `HALT: bash command unclassifiable. ${extractResult.uncertainReason}`,
      ledgerEntry: halt,
    };
  }

  // Check ALL targets — return worst verdict (HALT > ALLOW_VERIFY > ALLOW)
  let worstVerdict: InterceptVerdict = { action: 'ALLOW', reason: 'Bash command: no governed targets detected.' };
  for (const target of extractResult.targets) {
    const verdict = interceptWrite(target, 'write');
    if (verdict.action === 'HALT') {
      return verdict; // HALT is terminal, return immediately
    }
    if (verdict.action === 'ALLOW_VERIFY' && worstVerdict.action === 'ALLOW') {
      worstVerdict = verdict; // Escalate from ALLOW to ALLOW_VERIFY, keep checking for HALT
    }
  }

  return worstVerdict;
}

// ── Post-Write Verification ────────────────────────────────────────

/**
 * Verify a file exists on disk after a VERIFY-policy write.
 * Records the verification result.
 */
export function verifyWrite(targetPath: string): VerifyResult {
  const exists = fs.existsSync(targetPath);
  const result: VerifyResult = {
    target: targetPath,
    exists,
    timestamp: new Date().toISOString(),
  };

  if (exists) {
    try {
      const stats = fs.statSync(targetPath);
      result.sizeBytes = stats.size;
    } catch {
      // Size optional, don't fail verification
    }
  }

  state.verifications.push(result);
  return result;
}

// ── Supplemental Ledger Formatting ─────────────────────────────────

/**
 * Format all halts into a supplemental Decision Ledger for Jason.
 */
export function formatSupplementalLedger(): string {
  if (state.halts.length === 0) {
    return 'No action-time halts. All writes within clearance set or ungoverned.';
  }

  const lines: string[] = [];
  lines.push('## Decision-Surfacing Gate: Action-Time Supplemental Ledger');
  lines.push(`Build: ${state.clearanceSet?.buildId || 'unknown'}`);
  lines.push(`Status: HALTED -- ${state.halts.length} undeclared governed surface(s) touched.`);
  lines.push('');
  lines.push('These surfaces were NOT declared at plan-time. The build cannot proceed');
  lines.push('until Jason rules on each.');
  lines.push('');

  for (const halt of state.halts) {
    lines.push(`### ${halt.target}`);
    lines.push(`- Operation: ${halt.operation}`);
    lines.push(`- Policy: ${halt.policy}`);
    lines.push(`- Halt reason: ${halt.haltReason}`);
    lines.push(`- Detected: ${halt.timestamp}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Build Summary ──────────────────────────────────────────────────

/**
 * Produce end-of-build gate summary.
 */
export function buildGateSummary(): string {
  const lines: string[] = [];
  lines.push('## Gate Enforcement Summary');
  lines.push(`Armed: ${state.armed}`);
  lines.push(`Halts: ${state.halts.length}`);
  lines.push(`Verifications: ${state.verifications.length}`);

  if (state.verifications.length > 0) {
    const passed = state.verifications.filter(v => v.exists).length;
    const failed = state.verifications.filter(v => !v.exists).length;
    lines.push(`  Passed: ${passed}`);
    lines.push(`  Failed: ${failed}`);

    if (failed > 0) {
      lines.push('  FAILED VERIFICATIONS:');
      for (const v of state.verifications.filter(v => !v.exists)) {
        lines.push(`    - ${v.target} (expected on disk, not found)`);
      }
    }
  }

  return lines.join('\n');
}
