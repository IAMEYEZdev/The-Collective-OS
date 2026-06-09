/**
 * Decision-Surfacing Gate — Halt-and-Ruling Delivery Module (Step 4)
 *
 * Delivers gate halt ledgers to the operator (Jason) via the
 * appropriate harness injection surface:
 *
 * - Claude Code: CLAUDE.md injection (user-role authority, per C2 proof)
 * - Codex: AGENTS.md injection (project-root agent instructions)
 *
 * The delivery module writes the halt ledger into the target file
 * as a fenced block that Jason can see, rule on, and clear.
 *
 * It also handles clearance recording: when Jason approves,
 * the ruling is written back to confirm the gate opened.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { type DecisionLedger, formatLedgerForReview, type ClearanceSet } from './plan-time.js';
import { formatSupplementalLedger, type InterceptorState } from './action-time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────────────

export type DeliveryTarget = 'claude-code' | 'codex';

export interface DeliveryResult {
  delivered: boolean;
  target: DeliveryTarget;
  filePath: string;
  timestamp: string;
  error?: string;
}

export interface RulingRecord {
  buildId: string;
  ruledBy: string;
  ruledAt: string;
  approved: boolean;
  approvedSurfaceIds: string[];
  notes?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const GATE_BLOCK_START = '<!-- DECISION-SURFACING-GATE:START -->';
const GATE_BLOCK_END = '<!-- DECISION-SURFACING-GATE:END -->';

// ── Delivery Functions ─────────────────────────────────────────────

/**
 * Detect which harness we're running under.
 * Claude Code uses CLAUDE.md; Codex uses AGENTS.md.
 */
export function detectHarness(projectRoot: string): DeliveryTarget {
  // If AGENTS.md exists and CLAUDE.md doesn't, assume Codex
  const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');

  // Default to claude-code (primary harness)
  // Codex detection: AGENTS.md present as primary instruction surface
  if (fs.existsSync(agentsMdPath) && !fs.existsSync(claudeMdPath)) {
    return 'codex';
  }

  // Both exist: prefer CLAUDE.md (Claude Code primary, AGENTS.md as secondary)
  return 'claude-code';
}

/**
 * Get the injection file path for a given harness.
 */
export function getInjectionPath(projectRoot: string, target: DeliveryTarget): string {
  switch (target) {
    case 'claude-code':
      return path.join(projectRoot, 'CLAUDE.md');
    case 'codex':
      return path.join(projectRoot, 'AGENTS.md');
  }
}

/**
 * Deliver a plan-time halt ledger to the appropriate harness file.
 * Injects a fenced block that Jason can read and rule on.
 */
export function deliverPlanTimeHalt(
  projectRoot: string,
  ledger: DecisionLedger,
  target?: DeliveryTarget
): DeliveryResult {
  const harness = target || detectHarness(projectRoot);
  const filePath = getInjectionPath(projectRoot, harness);
  const timestamp = new Date().toISOString();

  try {
    const ledgerContent = formatLedgerForReview(ledger);
    const block = buildGateBlock(ledgerContent, ledger.buildId, 'plan-time');
    injectGateBlock(filePath, block);

    return { delivered: true, target: harness, filePath, timestamp };
  } catch (err) {
    return {
      delivered: false,
      target: harness,
      filePath,
      timestamp,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Deliver an action-time supplemental halt ledger.
 * Called when interceptor catches undeclared governed surface writes.
 */
export function deliverActionTimeHalt(
  projectRoot: string,
  buildId: string,
  target?: DeliveryTarget
): DeliveryResult {
  const harness = target || detectHarness(projectRoot);
  const filePath = getInjectionPath(projectRoot, harness);
  const timestamp = new Date().toISOString();

  try {
    const ledgerContent = formatSupplementalLedger();
    const block = buildGateBlock(ledgerContent, buildId, 'action-time');
    injectGateBlock(filePath, block);

    return { delivered: true, target: harness, filePath, timestamp };
  } catch (err) {
    return {
      delivered: false,
      target: harness,
      filePath,
      timestamp,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Record a ruling (approval/denial) back into the harness file.
 * Replaces the halt block with a clearance record.
 */
export function recordRuling(
  projectRoot: string,
  ruling: RulingRecord,
  target?: DeliveryTarget
): DeliveryResult {
  const harness = target || detectHarness(projectRoot);
  const filePath = getInjectionPath(projectRoot, harness);
  const timestamp = new Date().toISOString();

  try {
    const rulingBlock = buildRulingBlock(ruling);
    // Replace existing gate block with ruling record
    replaceGateBlock(filePath, rulingBlock);

    return { delivered: true, target: harness, filePath, timestamp };
  } catch (err) {
    return {
      delivered: false,
      target: harness,
      filePath,
      timestamp,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove the gate block from the harness file entirely.
 * Used after a build completes and the gate is no longer needed.
 */
export function clearGateBlock(
  projectRoot: string,
  target?: DeliveryTarget
): DeliveryResult {
  const harness = target || detectHarness(projectRoot);
  const filePath = getInjectionPath(projectRoot, harness);
  const timestamp = new Date().toISOString();

  try {
    removeGateBlock(filePath);
    return { delivered: true, target: harness, filePath, timestamp };
  } catch (err) {
    return {
      delivered: false,
      target: harness,
      filePath,
      timestamp,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Block Builders ─────────────────────────────────────────────────

function buildGateBlock(content: string, buildId: string, phase: 'plan-time' | 'action-time'): string {
  const lines: string[] = [];
  lines.push(GATE_BLOCK_START);
  lines.push(`<!-- Build: ${buildId} | Phase: ${phase} | Generated: ${new Date().toISOString()} -->`);
  lines.push('');
  lines.push(content);
  lines.push('');
  lines.push(GATE_BLOCK_END);
  return lines.join('\n');
}

function buildRulingBlock(ruling: RulingRecord): string {
  const lines: string[] = [];
  lines.push(GATE_BLOCK_START);
  lines.push(`<!-- Build: ${ruling.buildId} | Ruling recorded: ${ruling.ruledAt} -->`);
  lines.push('');
  lines.push(`## Decision-Surfacing Gate: Ruling Record`);
  lines.push(`Build: ${ruling.buildId}`);
  lines.push(`Ruled by: ${ruling.ruledBy}`);
  lines.push(`Ruled at: ${ruling.ruledAt}`);
  lines.push(`Approved: ${ruling.approved ? 'YES' : 'NO'}`);
  if (ruling.approvedSurfaceIds.length > 0) {
    lines.push(`Cleared surfaces: ${ruling.approvedSurfaceIds.join(', ')}`);
  }
  if (ruling.notes) {
    lines.push(`Notes: ${ruling.notes}`);
  }
  lines.push('');
  lines.push(GATE_BLOCK_END);
  return lines.join('\n');
}

// ── File Injection ─────────────────────────────────────────────────

function injectGateBlock(filePath: string, block: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  }

  // If a gate block already exists, replace it
  if (content.includes(GATE_BLOCK_START)) {
    replaceGateBlock(filePath, block);
    return;
  }

  // Append gate block at the end
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, content + separator + block + '\n', 'utf8');
}

function replaceGateBlock(filePath: string, newBlock: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, newBlock + '\n', 'utf8');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const startIdx = content.indexOf(GATE_BLOCK_START);
  const endIdx = content.indexOf(GATE_BLOCK_END);

  if (startIdx === -1 || endIdx === -1) {
    // No existing block, append
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(filePath, content + separator + newBlock + '\n', 'utf8');
    return;
  }

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + GATE_BLOCK_END.length);
  fs.writeFileSync(filePath, before + newBlock + after, 'utf8');
}

function removeGateBlock(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const startIdx = content.indexOf(GATE_BLOCK_START);
  const endIdx = content.indexOf(GATE_BLOCK_END);

  if (startIdx === -1 || endIdx === -1) return;

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + GATE_BLOCK_END.length);

  // Clean up extra newlines
  const cleaned = (before + after).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  fs.writeFileSync(filePath, cleaned, 'utf8');
}
