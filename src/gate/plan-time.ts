/**
 * Decision-Surfacing Gate — Plan-Time Classifier (Step 2)
 *
 * Runs once before a build begins. Enumerates all declared target
 * surfaces from the build plan, classifies each against the registry,
 * and produces a Decision Ledger for any governed surfaces.
 *
 * After Jason rules, approved surfaces become the clearance set
 * that the action-time interceptor trusts.
 */

import {
  classifyPath,
  classifyAction,
  loadRegistry,
  type Classification,
  type GatePolicy,
  type RegistryEntry,
} from './registry.js';

// ── Types ──────────────────────────────────────────────────────────

export interface DeclaredTarget {
  /** File path or action description */
  target: string;
  /** Why this target will be touched */
  reason: string;
  /** The tool/operation type planned */
  operation: 'write' | 'edit' | 'delete' | 'bash' | 'deploy' | 'publish' | 'send' | 'merge' | 'push';
}

export interface LedgerEntry {
  target: string;
  reason: string;
  operation: string;
  classification: Classification;
  actionClassification?: { governed: true; action: { id: string; severity: string } } | null;
  policy: GatePolicy | 'IRREVERSIBLE' | 'UNCERTAIN';
  requiresRuling: boolean;
}

export interface DecisionLedger {
  timestamp: string;
  buildId: string;
  totalDeclared: number;
  gated: LedgerEntry[];
  verified: LedgerEntry[];
  ungoverned: DeclaredTarget[];
  summary: string;
}

export interface ClearanceSet {
  buildId: string;
  approvedAt: string;
  approvedBy: string;
  /** Surface IDs that are cleared for write */
  clearedSurfaceIds: string[];
  /** Specific paths cleared (for pattern entries) */
  clearedPaths: string[];
  /** Whether all gated items were approved */
  fullApproval: boolean;
}

// ── Plan-Time Classification ───────────────────────────────────────

/**
 * Classify all declared targets and produce a Decision Ledger.
 *
 * This is the C trigger (structural floor). Returns the ledger
 * containing every governed surface that needs Jason's ruling.
 */
export function classifyBuildPlan(
  buildId: string,
  declaredTargets: DeclaredTarget[]
): DecisionLedger {
  const gated: LedgerEntry[] = [];
  const verified: LedgerEntry[] = [];
  const ungoverned: DeclaredTarget[] = [];

  for (const dt of declaredTargets) {
    const pathResult = classifyPath(dt.target);
    const actionResult = classifyAction(dt.target);

    // Irreversible action match = always GATE
    if (actionResult) {
      gated.push({
        target: dt.target,
        reason: dt.reason,
        operation: dt.operation,
        classification: pathResult,
        actionClassification: {
          governed: true,
          action: { id: actionResult.action.id, severity: actionResult.action.severity },
        },
        policy: 'IRREVERSIBLE',
        requiresRuling: true,
      });
      continue;
    }

    // UNCERTAIN: path unclassifiable, default-gated per C1
    if (!pathResult.governed && pathResult.uncertain) {
      gated.push({
        target: dt.target,
        reason: dt.reason,
        operation: dt.operation,
        classification: pathResult,
        policy: 'UNCERTAIN',
        requiresRuling: true,
      });
      continue;
    }

    if (pathResult.governed) {
      const entry: LedgerEntry = {
        target: dt.target,
        reason: dt.reason,
        operation: dt.operation,
        classification: pathResult,
        policy: pathResult.policy,
        requiresRuling: pathResult.policy === 'GATE',
      };

      if (pathResult.policy === 'GATE') {
        gated.push(entry);
      } else {
        // VERIFY policy: no ruling needed, but track for post-write verification
        verified.push(entry);
      }
    } else {
      ungoverned.push(dt);
    }
  }

  const summary = buildLedgerSummary(gated, verified, ungoverned, declaredTargets.length);

  return {
    timestamp: new Date().toISOString(),
    buildId,
    totalDeclared: declaredTargets.length,
    gated,
    verified,
    ungoverned,
    summary,
  };
}

function buildLedgerSummary(
  gated: LedgerEntry[],
  verified: LedgerEntry[],
  ungoverned: DeclaredTarget[],
  total: number
): string {
  if (gated.length === 0 && verified.length === 0) {
    return `BUILD UNGATED. ${total} declared targets, none governed. Proceed without ruling.`;
  }

  if (gated.length === 0) {
    return `BUILD VERIFY-ONLY. ${verified.length} VERIFY surfaces (post-write confirmation, no halt). ${ungoverned.length} ungoverned. No ruling required.`;
  }

  const irreversibleCount = gated.filter(g => g.policy === 'IRREVERSIBLE').length;
  const gateCount = gated.filter(g => g.policy === 'GATE').length;
  const uncertainCount = gated.filter(g => g.policy === 'UNCERTAIN').length;

  const parts: string[] = [];
  parts.push(`BUILD GATED. ${total} declared targets.`);
  if (gateCount > 0) parts.push(`${gateCount} GATE (ruling required).`);
  if (irreversibleCount > 0) parts.push(`${irreversibleCount} IRREVERSIBLE (ruling required).`);
  if (uncertainCount > 0) parts.push(`${uncertainCount} UNCERTAIN (unclassifiable target, default-gated per C1).`);
  if (verified.length > 0) parts.push(`${verified.length} VERIFY (post-write confirmation).`);
  parts.push(`${ungoverned.length} ungoverned.`);
  parts.push('HALT: awaiting Jason ruling on gated surfaces before build proceeds.');

  return parts.join(' ');
}

// ── Decision Ledger Formatting ─────────────────────────────────────

/**
 * Format a Decision Ledger for human review.
 * This is what gets injected into CLAUDE.md (Claude Code) or
 * AGENTS.md (Codex) for Jason to see and rule on.
 */
export function formatLedgerForReview(ledger: DecisionLedger): string {
  const lines: string[] = [];

  lines.push(`## Decision-Surfacing Gate: Plan-Time Ledger`);
  lines.push(`Build: ${ledger.buildId}`);
  lines.push(`Generated: ${ledger.timestamp}`);
  lines.push(`Status: ${ledger.gated.length > 0 ? 'HALTED -- AWAITING RULING' : 'CLEAR'}`);
  lines.push('');
  lines.push(ledger.summary);
  lines.push('');

  if (ledger.gated.length > 0) {
    lines.push('### Gated Surfaces (ruling required)');
    lines.push('');
    for (const g of ledger.gated) {
      const entryId = g.classification.governed
        ? (g.classification as any).entry.id
        : 'irreversible-action';
      const severity = g.actionClassification
        ? ` [${g.actionClassification.action.severity}]`
        : '';
      lines.push(`- **${entryId}**${severity}: \`${g.target}\``);
      lines.push(`  Operation: ${g.operation} | Policy: ${g.policy}`);
      lines.push(`  Reason: ${g.reason}`);
    }
    lines.push('');
  }

  if (ledger.verified.length > 0) {
    lines.push('### Verify Surfaces (no ruling needed, post-write confirmation)');
    lines.push('');
    for (const v of ledger.verified) {
      const entryId = v.classification.governed
        ? (v.classification as any).entry.id
        : 'unknown';
      lines.push(`- **${entryId}**: \`${v.target}\``);
      lines.push(`  Operation: ${v.operation} | Policy: VERIFY`);
    }
    lines.push('');
  }

  if (ledger.ungoverned.length > 0) {
    lines.push(`### Ungoverned (${ledger.ungoverned.length} targets, no gate)`);
    lines.push('');
    for (const u of ledger.ungoverned) {
      lines.push(`- \`${u.target}\`: ${u.operation} -- ${u.reason}`);
    }
  }

  return lines.join('\n');
}

// ── Clearance Set Builder ──────────────────────────────────────────

/**
 * Build a clearance set from a ruled ledger.
 * Called after Jason approves (all or partial) gated surfaces.
 */
export function buildClearanceSet(
  ledger: DecisionLedger,
  approvedBy: string,
  approvedSurfaceIds: string[] | 'ALL'
): ClearanceSet {
  const allGatedIds = ledger.gated.map(g => {
    if (g.classification.governed) {
      return (g.classification as any).entry.id as string;
    }
    return g.actionClassification
      ? g.actionClassification.action.id
      : `unknown-${g.target}`;
  });

  // Clone to avoid mutating caller's array
  const clearedIds = approvedSurfaceIds === 'ALL'
    ? [...allGatedIds]
    : [...approvedSurfaceIds];

  // Compute fullApproval BEFORE adding VERIFY IDs (which aren't gated)
  const fullApproval = approvedSurfaceIds === 'ALL'
    || allGatedIds.every(id => clearedIds.includes(id));

  // Collect specific paths for cleared surfaces
  const clearedPaths: string[] = [];
  for (const g of ledger.gated) {
    const entryId = g.classification.governed
      ? (g.classification as any).entry.id
      : null;
    if (entryId && clearedIds.includes(entryId)) {
      clearedPaths.push(g.target);
    }
  }

  // VERIFY surfaces are always cleared (no ruling needed)
  for (const v of ledger.verified) {
    if (v.classification.governed) {
      const entry = (v.classification as any).entry;
      clearedIds.push(entry.id);
      clearedPaths.push(v.target);
    }
  }

  return {
    buildId: ledger.buildId,
    approvedAt: new Date().toISOString(),
    approvedBy,
    clearedSurfaceIds: [...new Set(clearedIds)],
    clearedPaths: [...new Set(clearedPaths)],
    fullApproval,
  };
}

/**
 * Check if a path is in the clearance set.
 */
export function isCleared(targetPath: string, clearance: ClearanceSet): boolean {
  // Check direct path match
  for (const cp of clearance.clearedPaths) {
    if (normalizeClearancePath(cp) === normalizeClearancePath(targetPath)) {
      return true;
    }
  }

  // Check if the target matches any cleared surface by re-classifying
  const classification = classifyPath(targetPath);
  if (classification.governed) {
    return clearance.clearedSurfaceIds.includes(classification.entry.id);
  }

  return false;
}

function normalizeClearancePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
