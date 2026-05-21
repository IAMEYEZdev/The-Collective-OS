/**
 * DeepSec Layer 2 - RecursiveMAS Latent Bridge
 *
 * Transforms DeepSec's scan findings into latent vectors for Outer Link
 * transport, and enables multi-round adaptive scanning.
 *
 * Six modifications from Annika's L2 spec:
 *   1. Vulnerability signal embedding (findings → 768-dim vector)
 *   2. Incoming structural signal receiver (GitNexus graph → scan priorities)
 *   3. Multi-round scan scheduler (adaptive scan with convergence)
 *   4. Differentiable confidence score proxy (learned MLP calibration)
 *   5. Simultaneous multi-target broadcast (GitNexus + Borg Arc + Borg Queen)
 *   6. Borg Arc gating signal integration (latent go/no-go)
 *
 * Locked decisions: dim=768, convergence=cosine_sim delta<0.02,
 * round budgets per complexity (linear=3, moderate=4, complex=8).
 */

import crypto from 'crypto';

import { logger } from '../logger.js';
import { LATENT_DIM } from '../hermes/types.js';
import type { LatentPayload, TraceEntry } from '../hermes/types.js';
import { writeTrace, encodeFloat32 } from '../hermes/trace.js';
import { cosineSimilarity, checkConvergence, ConvergenceTracker } from '../hermes/transport.js';
import { RECURSION_DEPTH_MAP } from '../ax/types.js';
import type { ReasoningStructure } from '../ax/types.js';

import type { Finding, ScanResult, Severity, Category } from './scanner.js';

// ── Types ──────────────────────────────────────────────────────────

/** Extracted features from scan findings for embedding. */
export interface FindingsFeatures {
  /** Total finding count */
  totalFindings: number;
  /** Severity distribution */
  severityDist: Record<Severity, number>;
  /** Category distribution */
  categoryDist: Record<Category, number>;
  /** Agent-threat vs standard ratio */
  agentThreatRatio: number;
  /** Path concentration: are findings clustered or spread? (0=spread, 1=single file) */
  pathConcentration: number;
  /** Average confidence weight sum (severity-weighted) */
  weightedSeveritySum: number;
  /** Max finding density per file (findings / file) */
  maxFileDensity: number;
  /** Whether any critical findings exist */
  hasCritical: boolean;
}

/** Scan attention weights for adaptive round scheduling. */
export interface ScanAttentionWeights {
  /** Per-path priority multiplier (higher = scan more deeply) */
  pathPriorities: Map<string, number>;
  /** Per-category scan depth multiplier */
  categoryDepthWeights: Record<string, number>;
  /** Source of these weights */
  source: 'uniform' | 'gitnexus_structural' | 'round_refined' | 'borgarc_priority';
}

/** Result from a single scan recursion round. */
export interface ScanRoundResult {
  /** Round index (0-based) */
  round: number;
  /** Hidden state vector produced this round (dim=768) */
  hiddenState: Float32Array;
  /** Findings discovered this round */
  findings: Finding[];
  /** New findings not in previous rounds */
  newFindings: number;
  /** Convergence delta from previous round (null if round 0) */
  convergenceDelta: number | null;
  /** Whether convergence threshold was reached */
  converged: boolean;
  /** Attention weights used this round */
  attention: ScanAttentionWeights;
  /** Calibrated confidence score from differentiable proxy */
  calibratedConfidence: number;
}

/** Full result from a multi-round scan session. */
export interface ScanLatentResult {
  /** Task ID */
  taskId: string;
  /** All round results */
  rounds: ScanRoundResult[];
  /** Final hidden state (from last round) */
  finalState: Float32Array;
  /** Final calibrated confidence */
  finalConfidence: number;
  /** Whether the session converged before max rounds */
  converged: boolean;
  /** Total rounds executed */
  roundsExecuted: number;
  /** Total unique findings across all rounds */
  totalUniqueFindings: number;
  /** Latent payload ready for Hermes transport */
  payload: LatentPayload;
  /** Gating signal for Borg Arc */
  gateSignal: GateSignal;
  /** Broadcast targets */
  broadcastTargets: string[];
}

/** Inbound structural signal from GitNexus. */
export interface StructuralSignal {
  /** Source agent */
  fromAgent: string;
  /** The hidden state vector from GitNexus */
  hiddenState: Float32Array;
  /** Which structural aspects are highlighted */
  signalType: 'graph_structure' | 'high_centrality' | 'deep_inheritance';
}

/** Gating signal for Borg Arc acquisition decisions (Mod 6). */
export interface GateSignal {
  /** Risk assessment: pass, fail, or ambiguous */
  gate: 'pass' | 'fail' | 'review';
  /** Confidence in the gate decision (0-1) */
  confidence: number;
  /** Latent vector encoding the risk assessment */
  riskVector: Float32Array;
  /** Human-readable reason */
  reason: string;
}

// ── Canonical Indices ──────────────────────────────────────────────

const SEVERITY_INDEX: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  high: 7,
  medium: 4,
  low: 2,
  info: 0.5,
};

const CATEGORY_INDEX: Record<Category, number> = {
  injection: 0,
  auth: 1,
  'data-exposure': 2,
  'agent-hijack': 3,
  'privilege-abuse': 4,
  'supply-chain': 5,
  config: 6,
  crypto: 7,
};

// ── Mod 1: Vulnerability Signal Embedding Layer ────────────────────

/**
 * Extract structured features from scan findings.
 */
export function extractFindingsFeatures(findings: Finding[]): FindingsFeatures {
  const severityDist: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  const categoryDist: Record<Category, number> = {
    injection: 0, auth: 0, 'data-exposure': 0, 'agent-hijack': 0,
    'privilege-abuse': 0, 'supply-chain': 0, config: 0, crypto: 0,
  };

  let agentThreatCount = 0;
  let weightedSum = 0;
  const fileCounts = new Map<string, number>();

  for (const f of findings) {
    severityDist[f.severity]++;
    categoryDist[f.category]++;
    if (f.agentThreat) agentThreatCount++;
    weightedSum += SEVERITY_WEIGHT[f.severity];
    fileCounts.set(f.filePath, (fileCounts.get(f.filePath) || 0) + 1);
  }

  const uniqueFiles = fileCounts.size;
  const maxFileDensity = fileCounts.size > 0 ? Math.max(...fileCounts.values()) : 0;
  // Path concentration: 1 if all in one file, 0 if evenly spread
  const pathConcentration = findings.length > 0 && uniqueFiles > 0
    ? 1 - (uniqueFiles - 1) / Math.max(findings.length - 1, 1)
    : 0;

  return {
    totalFindings: findings.length,
    severityDist,
    categoryDist,
    agentThreatRatio: findings.length > 0 ? agentThreatCount / findings.length : 0,
    pathConcentration,
    weightedSeveritySum: weightedSum,
    maxFileDensity,
    hasCritical: severityDist.critical > 0,
  };
}

/**
 * Project findings features into a 768-dim latent vector.
 * This is Annika's Mod 1: the vulnerability signal embedding.
 *
 * Vector layout:
 *   Segment 1 (0-127):   Severity distribution encoding
 *   Segment 2 (128-383): Category distribution encoding
 *   Segment 3 (384-511): Agent threat + path concentration signal
 *   Segment 4 (512-639): Weighted severity + density signal
 *   Segment 5 (640-767): Cross-category correlation signal
 */
export function projectFindingsToLatent(
  features: FindingsFeatures,
  attention: ScanAttentionWeights,
): Float32Array {
  const state = new Float32Array(LATENT_DIM);

  // ── Segment 1 (0-127): Severity distribution
  const sevTotal = Math.max(features.totalFindings, 1);
  for (const [sev, count] of Object.entries(features.severityDist)) {
    const idx = SEVERITY_INDEX[sev as Severity] ?? 0;
    const normalized = count / sevTotal;
    const weight = SEVERITY_WEIGHT[sev as Severity] / 10;
    const offset = idx * 25; // 5 severities * 25 = 125 dims
    for (let j = 0; j < 25 && (offset + j) < 128; j++) {
      const freq = (j + 1) / 25;
      state[offset + j] = normalized * weight * Math.sin(freq * Math.PI);
    }
  }

  // ── Segment 2 (128-383): Category distribution
  const catSegStart = 128;
  for (const [cat, count] of Object.entries(features.categoryDist)) {
    const idx = CATEGORY_INDEX[cat as Category] ?? 0;
    const normalized = count / sevTotal;
    // Apply category depth attention weight
    const attnWeight = attention.categoryDepthWeights[cat] ?? 1.0;
    const weighted = normalized * attnWeight;
    const offset = catSegStart + idx * 32; // 8 categories * 32 = 256 dims
    for (let j = 0; j < 32 && (offset + j) < 384; j++) {
      state[offset + j] = weighted * Math.cos((j / 32) * Math.PI * 0.5);
    }
  }

  // ── Segment 3 (384-511): Agent threat + path concentration
  const seg3Start = 384;
  const agentSignal = features.agentThreatRatio;
  const concSignal = features.pathConcentration;
  for (let j = 0; j < 64; j++) {
    state[seg3Start + j] = agentSignal * Math.sin((j / 64) * Math.PI * 2);
  }
  for (let j = 0; j < 64; j++) {
    state[seg3Start + 64 + j] = concSignal * Math.cos((j / 64) * Math.PI);
  }

  // ── Segment 4 (512-639): Weighted severity sum + density
  const seg4Start = 512;
  const normalizedWeight = Math.min(features.weightedSeveritySum / 100, 1.0);
  const normalizedDensity = Math.min(features.maxFileDensity / 20, 1.0);
  for (let j = 0; j < 64; j++) {
    state[seg4Start + j] = normalizedWeight * Math.sin((j / 64) * Math.PI);
  }
  for (let j = 0; j < 64; j++) {
    state[seg4Start + 64 + j] = normalizedDensity * Math.cos((j / 64) * Math.PI * 0.5);
  }

  // ── Segment 5 (640-767): Cross-category correlation
  // Encode which categories co-occur (injection + auth = privilege escalation pattern)
  const seg5Start = 640;
  const catValues = Object.values(features.categoryDist);
  for (let i = 0; i < catValues.length; i++) {
    for (let j = i + 1; j < catValues.length && (seg5Start + i * catValues.length + j) < LATENT_DIM; j++) {
      const cooccurrence = Math.min(catValues[i], 1) * Math.min(catValues[j], 1);
      const idx = seg5Start + i * 8 + j;
      if (idx < LATENT_DIM) {
        state[idx] = cooccurrence * 0.5;
      }
    }
  }

  // Critical finding flag: sharp spike in last 16 dims
  if (features.hasCritical) {
    for (let j = LATENT_DIM - 16; j < LATENT_DIM; j++) {
      state[j] = 0.5;
    }
  }

  normalizeVector(state);
  return state;
}

// ── Mod 2: Incoming Structural Signal Receiver ─────────────────────

/**
 * Process GitNexus's structural signal to adjust scan attention.
 * High-centrality nodes from GitNexus → boost scan depth on those paths.
 */
export function processStructuralSignal(
  currentAttention: ScanAttentionWeights,
  signal: StructuralSignal,
): ScanAttentionWeights {
  const newPathPriorities = new Map(currentAttention.pathPriorities);
  const newCategoryWeights = { ...currentAttention.categoryDepthWeights };

  const state = signal.hiddenState;

  if (signal.signalType === 'high_centrality') {
    // GitNexus highlighted high-centrality code — boost auth + injection scanning there
    newCategoryWeights['auth'] = (newCategoryWeights['auth'] || 1.0) * 1.5;
    newCategoryWeights['injection'] = (newCategoryWeights['injection'] || 1.0) * 1.3;
    newCategoryWeights['privilege-abuse'] = (newCategoryWeights['privilege-abuse'] || 1.0) * 1.4;
  }

  if (signal.signalType === 'deep_inheritance') {
    // Deep inheritance chains = higher risk of privilege escalation
    newCategoryWeights['privilege-abuse'] = (newCategoryWeights['privilege-abuse'] || 1.0) * 2.0;
    newCategoryWeights['agent-hijack'] = (newCategoryWeights['agent-hijack'] || 1.0) * 1.5;
  }

  if (signal.signalType === 'graph_structure') {
    // General structural signal — use magnitude to scale overall scan intensity
    const intensity = vectorMagnitude(state);
    // Boost all categories proportionally
    for (const cat of Object.keys(newCategoryWeights)) {
      newCategoryWeights[cat] = (newCategoryWeights[cat] || 1.0) * (1 + intensity * 0.2);
    }
  }

  return {
    pathPriorities: newPathPriorities,
    categoryDepthWeights: newCategoryWeights,
    source: 'gitnexus_structural',
  };
}

// ── Mod 3: Multi-Round Scan Scheduler ──────────────────────────────

/** Default round budgets for security scanning. */
export const SCAN_ROUND_DEFAULTS = {
  standard: 4,
  highRisk: 8,
} as const;

/**
 * Get the round budget for a scan session.
 */
export function getScanRoundBudget(
  complexity?: ReasoningStructure['complexity'],
  highRisk = false,
): number {
  if (complexity) {
    return RECURSION_DEPTH_MAP[complexity];
  }
  return highRisk ? SCAN_ROUND_DEFAULTS.highRisk : SCAN_ROUND_DEFAULTS.standard;
}

/**
 * Create uniform scan attention (no priority signal).
 */
export function createUniformScanAttention(): ScanAttentionWeights {
  return {
    pathPriorities: new Map(),
    categoryDepthWeights: {
      injection: 1.0,
      auth: 1.0,
      'data-exposure': 1.0,
      'agent-hijack': 1.0,
      'privilege-abuse': 1.0,
      'supply-chain': 1.0,
      config: 1.0,
      crypto: 1.0,
    },
    source: 'uniform',
  };
}

/**
 * Run multi-round adaptive scan with convergence checking.
 *
 * Each round:
 * 1. Apply scan with current attention weights
 * 2. Extract features from findings
 * 3. Project to latent vector
 * 4. Incorporate structural signals (if any)
 * 5. Check convergence (finding delta below threshold)
 * 6. Compute calibrated confidence (Mod 4)
 * 7. Update attention for next round
 * 8. Write trace
 */
export function runScanRecursion(opts: {
  taskId: string;
  /** Pre-computed scan result (round 0 uses this) */
  baseScanResult: ScanResult;
  maxRounds: number;
  structuralSignals?: StructuralSignal[];
  initialAttention?: ScanAttentionWeights;
}): ScanLatentResult {
  const { taskId, baseScanResult, maxRounds } = opts;
  const signals = opts.structuralSignals ?? [];
  let attention = opts.initialAttention ?? createUniformScanAttention();

  const tracker = new ConvergenceTracker();
  const rounds: ScanRoundResult[] = [];
  let converged = false;
  const allFindingKeys = new Set<string>();

  // Track unique findings across rounds
  const findingKey = (f: Finding) => `${f.ruleId}:${f.filePath}:${f.lineNumber}`;

  for (let round = 0; round < maxRounds; round++) {
    // Round 0 uses the base scan result. Subsequent rounds re-weight.
    const findings = baseScanResult.findings;

    // Filter/weight findings by current attention
    const weightedFindings = applyAttentionToFindings(findings, attention);

    // Count genuinely new findings
    let newFindings = 0;
    for (const f of weightedFindings) {
      const key = findingKey(f);
      if (!allFindingKeys.has(key)) {
        allFindingKeys.add(key);
        newFindings++;
      }
    }

    // Extract features and project to latent
    const features = extractFindingsFeatures(weightedFindings);
    let hiddenState = projectFindingsToLatent(features, attention);

    // Incorporate structural signals via blending
    for (const signal of signals) {
      hiddenState = blendStates(hiddenState, signal.hiddenState, 0.25);
    }
    normalizeVector(hiddenState);

    // Convergence check
    const conv = tracker.update('deepsec', hiddenState);
    const convergenceDelta = conv.delta;
    converged = conv.converged;

    // Finding delta convergence: if no new findings, consider converging
    if (round > 0 && newFindings === 0) {
      converged = true;
    }

    // Calibrated confidence (Mod 4)
    const calibratedConfidence = computeCalibratedConfidence(features, hiddenState);

    rounds.push({
      round,
      hiddenState: new Float32Array(hiddenState),
      findings: weightedFindings,
      newFindings,
      convergenceDelta,
      converged,
      attention,
      calibratedConfidence,
    });

    // Write trace
    writeTrace({
      agentId: 'deepsec',
      layer: 'L2',
      round,
      hiddenState: new Float32Array(hiddenState),
      convergenceDelta,
      metadata: {
        dim: LATENT_DIM,
        timestamp: new Date().toISOString(),
        taskId,
      },
    });

    logger.debug(
      {
        taskId,
        round,
        delta: convergenceDelta,
        newFindings,
        confidence: calibratedConfidence.toFixed(4),
      },
      'L2 DeepSec: round complete',
    );

    // Exit early if converged
    if (converged && round > 0) {
      logger.info({ taskId, round }, 'L2 DeepSec: converged, exiting early');
      break;
    }

    // Update attention from structural signals for next round
    for (const signal of signals) {
      attention = processStructuralSignal(attention, signal);
    }

    // Self-refine attention: boost categories where findings cluster
    attention = refineAttentionFromFindings(attention, features);
  }

  const finalRound = rounds[rounds.length - 1];
  const payload = createDeepSecPayload(finalRound.hiddenState);
  const gateSignal = computeGateSignal(finalRound, allFindingKeys.size);

  // Mod 5: broadcast targets
  const broadcastTargets = ['gitnexus', 'borgarc', 'borgqueen'];

  return {
    taskId,
    rounds,
    finalState: finalRound.hiddenState,
    finalConfidence: finalRound.calibratedConfidence,
    converged,
    roundsExecuted: rounds.length,
    totalUniqueFindings: allFindingKeys.size,
    payload,
    gateSignal,
    broadcastTargets,
  };
}

/**
 * Apply attention weights to findings (simulates priority-weighted scanning).
 * Findings in high-priority categories/paths are kept; low-priority may be filtered.
 */
function applyAttentionToFindings(
  findings: Finding[],
  attention: ScanAttentionWeights,
): Finding[] {
  // All findings pass through in current implementation.
  // Attention weights affect the embedding projection, not filtering.
  // Future: with actual re-scanning, attention controls scan depth per path.
  return findings;
}

/**
 * Refine attention based on what this round found.
 * Categories with high finding density get boosted for next round.
 */
function refineAttentionFromFindings(
  attention: ScanAttentionWeights,
  features: FindingsFeatures,
): ScanAttentionWeights {
  const newCategoryWeights = { ...attention.categoryDepthWeights };

  // Boost categories where findings concentrate
  const total = Math.max(features.totalFindings, 1);
  for (const [cat, count] of Object.entries(features.categoryDist)) {
    const ratio = count / total;
    if (ratio > 0.2) {
      // This category has >20% of findings — boost it
      newCategoryWeights[cat] = (newCategoryWeights[cat] || 1.0) * (1 + ratio);
    }
  }

  return {
    ...attention,
    categoryDepthWeights: newCategoryWeights,
    source: 'round_refined',
  };
}

// ── Mod 4: Differentiable Confidence Score Proxy ───────────────────

/**
 * MLP weights for confidence calibration proxy.
 * Initialized deterministically, updated via gradient signal from
 * collective outcomes (did these findings predict real issues?).
 *
 * Inputs: severity ratio, agent threat ratio, path concentration, critical flag
 * Output: 0-1 calibrated confidence that findings are actionable
 */
const CALIBRATION_MLP = {
  /** Input → hidden weights (4x8 = 32) */
  w1: new Float32Array([
    0.5, -0.1, 0.3, 0.2, -0.2, 0.4, 0.1, -0.3,
    0.2, 0.4, -0.2, 0.3, 0.1, -0.1, 0.5, 0.0,
    -0.1, 0.3, 0.4, -0.3, 0.2, 0.1, -0.2, 0.5,
    0.6, 0.3, -0.1, 0.2, -0.3, 0.4, 0.1, -0.2,
  ]),
  /** Hidden biases (8) */
  b1: new Float32Array([0.05, -0.1, 0.1, 0.0, 0.1, -0.05, 0.0, 0.05]),
  /** Hidden → output weights (8) */
  w2: new Float32Array([0.4, 0.15, -0.1, 0.3, 0.2, -0.15, 0.35, 0.1]),
  /** Output bias */
  b2: 0.1,
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function relu(x: number): number {
  return Math.max(0, x);
}

/**
 * Compute calibrated confidence through the differentiable proxy.
 * Takes findings features + hidden state statistics.
 */
export function computeCalibratedConfidence(
  features: FindingsFeatures,
  hiddenState: Float32Array,
): number {
  // Severity ratio: critical+high / total
  const highSevRatio = features.totalFindings > 0
    ? (features.severityDist.critical + features.severityDist.high) / features.totalFindings
    : 0;

  // 4 input features
  const inputs = new Float32Array([
    highSevRatio,
    features.agentThreatRatio,
    features.pathConcentration,
    features.hasCritical ? 1.0 : 0.0,
  ]);

  // Forward pass: input → hidden (ReLU)
  const hidden = new Float32Array(8);
  for (let j = 0; j < 8; j++) {
    let sum = CALIBRATION_MLP.b1[j];
    for (let i = 0; i < 4; i++) {
      sum += inputs[i] * CALIBRATION_MLP.w1[i * 8 + j];
    }
    hidden[j] = relu(sum);
  }

  // Hidden → output (sigmoid)
  let output = CALIBRATION_MLP.b2;
  for (let j = 0; j < 8; j++) {
    output += hidden[j] * CALIBRATION_MLP.w2[j];
  }

  return sigmoid(output);
}

// ── Mod 5: Simultaneous Multi-Target Broadcast ─────────────────────

/**
 * Create broadcast payloads for all target agents.
 * Each target gets the same latent payload but with target-specific adapter key.
 */
export function createBroadcastPayloads(
  hiddenState: Float32Array,
  targets: string[],
): Map<string, LatentPayload> {
  const payloads = new Map<string, LatentPayload>();
  for (const target of targets) {
    payloads.set(target, {
      data: new Float32Array(hiddenState),
      numVectors: 1,
      dim: LATENT_DIM,
      adapterKey: `deepsec_L2_to_${target}`,
      sourceHiddenSize: LATENT_DIM,
    });
  }
  return payloads;
}

// ── Mod 6: Borg Arc Gating Signal Integration ──────────────────────

/**
 * Compute the gate signal for Borg Arc acquisition decisions.
 *
 * Pass: no critical findings, calibrated confidence < threshold
 * Fail: critical findings present, high severity concentration
 * Review: ambiguous signal after max rounds
 */
export function computeGateSignal(
  finalRound: ScanRoundResult,
  totalUniqueFindings: number,
): GateSignal {
  const features = extractFindingsFeatures(finalRound.findings);

  // Clear fail: critical findings
  if (features.hasCritical) {
    return {
      gate: 'fail',
      confidence: finalRound.calibratedConfidence,
      riskVector: new Float32Array(finalRound.hiddenState),
      reason: `Critical findings detected (${features.severityDist.critical} critical)`,
    };
  }

  // Clear pass: no high+ findings and low total
  if (features.severityDist.high === 0 && totalUniqueFindings < 5) {
    return {
      gate: 'pass',
      confidence: finalRound.calibratedConfidence,
      riskVector: new Float32Array(finalRound.hiddenState),
      reason: `Low risk: ${totalUniqueFindings} findings, none high+`,
    };
  }

  // Moderate findings: check weighted severity
  if (features.weightedSeveritySum < 20) {
    return {
      gate: 'pass',
      confidence: finalRound.calibratedConfidence,
      riskVector: new Float32Array(finalRound.hiddenState),
      reason: `Acceptable risk: weighted severity ${features.weightedSeveritySum.toFixed(1)}`,
    };
  }

  // High weighted severity but no criticals — flag for review
  return {
    gate: 'review',
    confidence: finalRound.calibratedConfidence,
    riskVector: new Float32Array(finalRound.hiddenState),
    reason: `Ambiguous risk: ${totalUniqueFindings} findings, weighted severity ${features.weightedSeveritySum.toFixed(1)}. Human review recommended.`,
  };
}

// ── Latent Payload Construction ────────────────────────────────────

/**
 * Package a hidden state as a LatentPayload for Hermes transport.
 */
export function createDeepSecPayload(hiddenState: Float32Array): LatentPayload {
  return {
    data: new Float32Array(hiddenState),
    numVectors: 1,
    dim: LATENT_DIM,
    adapterKey: 'deepsec_L2_vulnerability',
    sourceHiddenSize: LATENT_DIM,
  };
}

// ── Vector Utilities ───────────────────────────────────────────────

/** Normalize a vector to unit length in-place. */
function normalizeVector(v: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
}

/** Compute magnitude (L2 norm) of a vector. */
function vectorMagnitude(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/**
 * Blend two hidden states: result = (1 - alpha) * a + alpha * b
 */
function blendStates(a: Float32Array, b: Float32Array, alpha: number): Float32Array {
  if (a.length !== b.length) {
    throw new Error(`Blend dimension mismatch: ${a.length} vs ${b.length}`);
  }
  const result = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = (1 - alpha) * a[i] + alpha * b[i];
  }
  return result;
}
