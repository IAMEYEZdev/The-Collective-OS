/**
 * Borg Arc Latent Bridge — Layer 3 RecursiveMAS Integration
 *
 * Borg Arc is the acquisition coordinator. Unlike L1/L2 (analytical agents),
 * L3 orchestrates parallel evaluation threads, each running GitNexus + DeepSec
 * as a mini RecursiveMAS cluster.
 *
 * 6 Modifications per Annika's L3 spec:
 *   Mod 1: Parallel Acquisition Thread Manager
 *   Mod 2: Task-Intent Initialization Signal
 *   Mod 3: Latent State Handoff (receive L1/L2 hidden states)
 *   Mod 4: Multi-Round Acquisition Decision Aggregator
 *   Mod 5: Pre-Screening Latent Filter
 *   Mod 6: Borg Queen Reporting Interface
 */

import { LATENT_DIM } from '../hermes/types.js';
import type { LatentPayload } from '../hermes/types.js';
import { ConvergenceTracker } from '../hermes/transport.js';
import { writeTrace } from '../hermes/trace.js';
import type { RepoAnalysis, ForkabilityAssessment, ComplexityMetrics } from './analyzer.js';
import type { GraphLatentResult } from '../gitnexus/latent-bridge.js';
import type { ScanLatentResult, GateSignal } from '../deepsec/latent-bridge.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface AcquisitionIntent {
  /** What Borg Arc prioritizes for this repo evaluation */
  priority: 'security_validation' | 'structural_compatibility' | 'technology_assessment';
  /** Which collective layer this repo is intended to augment */
  targetLayer: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'general';
  /** Risk tolerance for this acquisition */
  riskTolerance: 'conservative' | 'standard' | 'aggressive';
}

export interface AcquisitionThreadConfig {
  threadId: string;
  repoUrl: string;
  repoPath: string;
  intent: AcquisitionIntent;
  maxRounds: number;
}

export interface ThreadRoundResult {
  round: number;
  assessmentState: Float32Array;
  convergenceDelta: number | null;
  provisionalDecision: 'absorb' | 'skip' | 'review';
  confidenceLevel: number;
  /** Signals received from L1/L2 this round */
  l1Signal?: Float32Array;
  l2Signal?: Float32Array;
  l2Gate?: GateSignal;
}

export interface AcquisitionThreadResult {
  threadId: string;
  repoUrl: string;
  rounds: ThreadRoundResult[];
  converged: boolean;
  finalDecision: 'absorb' | 'skip' | 'review';
  finalConfidence: number;
  finalState: Float32Array;
  /** Pre-screening quality tier that determined resource allocation */
  qualityTier: 'high' | 'standard' | 'borderline';
}

export interface PreScreeningSignal {
  qualityTier: 'high' | 'standard' | 'borderline' | 'drop';
  /** 768-dim candidate quality vector for thread priority initialization */
  qualityVector: Float32Array;
  /** Recommended round count based on quality */
  recommendedRounds: number;
  /** Score breakdown for transparency */
  scores: {
    license: number;
    maintenance: number;
    forkability: number;
    complexity: number;
  };
}

export interface BorgQueenReport {
  threadId: string;
  repoUrl: string;
  decision: 'absorb' | 'skip' | 'review';
  confidence: number;
  /** 768-dim hidden state encoding the full acquisition analysis */
  hiddenState: Float32Array;
  /** Key factors encoded in the state */
  factors: {
    structuralCompatibility: number;
    securityRisk: number;
    integrationComplexity: number;
    valueAlignment: number;
  };
  /** Target layer for this acquisition */
  targetLayer: string;
}

export interface BorgQueenContext {
  /** Global context signal from Borg Queen about collective gaps */
  gapSignal: Float32Array;
  /** Priority adjustments for specific layers */
  layerPriorities: Record<string, number>;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Default parallel thread count */
export const DEFAULT_THREAD_COUNT = 5;

/** Round budgets per quality tier */
export const TIER_ROUND_BUDGETS = {
  high: 6,
  standard: 4,
  borderline: 2,
} as const;

/** Intent dimension offsets in the 768-dim vector */
const INTENT_SEGMENTS = {
  priority: { start: 0, end: 128 },       // acquisition priority encoding
  targetLayer: { start: 128, end: 256 },   // target layer encoding
  riskTolerance: { start: 256, end: 384 }, // risk tolerance encoding
  qualityInit: { start: 384, end: 512 },   // pre-screening quality signal
  reserved: { start: 512, end: 768 },      // reserved for Borg Queen context
} as const;

/** Assessment dimension offsets in the 768-dim vector */
const ASSESSMENT_SEGMENTS = {
  structural: { start: 0, end: 192 },       // L1 GitNexus signal aggregation
  security: { start: 192, end: 384 },       // L2 DeepSec signal aggregation
  compatibility: { start: 384, end: 512 },  // cross-signal compatibility
  decision: { start: 512, end: 640 },       // decision confidence encoding
  factors: { start: 640, end: 768 },        // key factor decomposition
} as const;

// Priority encoding values
const PRIORITY_ENCODING: Record<AcquisitionIntent['priority'], number> = {
  security_validation: 0.9,
  structural_compatibility: 0.7,
  technology_assessment: 0.5,
};

// Target layer encoding (sinusoidal, like L5 Self-Discover)
const LAYER_ENCODING: Record<AcquisitionIntent['targetLayer'], number> = {
  L1: 0.15,
  L2: 0.30,
  L3: 0.45,
  L4: 0.60,
  L5: 0.75,
  L6: 0.90,
  general: 0.50,
};

// Risk tolerance encoding
const RISK_ENCODING: Record<AcquisitionIntent['riskTolerance'], number> = {
  conservative: 0.2,
  standard: 0.5,
  aggressive: 0.8,
};

// ── Mod 2: Task-Intent Initialization Signal ───────────────────────────

/**
 * Encode acquisition intent into a 768-dim initialization vector.
 * GitNexus and DeepSec receive this before their first recursion round
 * to initialize non-uniform attention.
 */
export function encodeIntentSignal(
  intent: AcquisitionIntent,
  preScreening?: PreScreeningSignal,
): Float32Array {
  const vec = new Float32Array(LATENT_DIM);

  // Segment 1: Priority encoding (0-127)
  const priorityVal = PRIORITY_ENCODING[intent.priority];
  for (let i = INTENT_SEGMENTS.priority.start; i < INTENT_SEGMENTS.priority.end; i++) {
    // Sinusoidal encoding for richer representation
    const pos = (i - INTENT_SEGMENTS.priority.start) / 128;
    vec[i] = priorityVal * Math.sin(pos * Math.PI * 2 + priorityVal);
  }

  // Segment 2: Target layer encoding (128-255)
  const layerVal = LAYER_ENCODING[intent.targetLayer];
  for (let i = INTENT_SEGMENTS.targetLayer.start; i < INTENT_SEGMENTS.targetLayer.end; i++) {
    const pos = (i - INTENT_SEGMENTS.targetLayer.start) / 128;
    vec[i] = layerVal * Math.cos(pos * Math.PI * 3 + layerVal);
  }

  // Segment 3: Risk tolerance (256-383)
  const riskVal = RISK_ENCODING[intent.riskTolerance];
  for (let i = INTENT_SEGMENTS.riskTolerance.start; i < INTENT_SEGMENTS.riskTolerance.end; i++) {
    const pos = (i - INTENT_SEGMENTS.riskTolerance.start) / 128;
    vec[i] = riskVal * Math.sin(pos * Math.PI + riskVal * 2);
  }

  // Segment 4: Pre-screening quality signal (384-511)
  if (preScreening) {
    const qualSeg = INTENT_SEGMENTS.qualityInit;
    const qualLen = qualSeg.end - qualSeg.start;
    for (let i = 0; i < qualLen && i < preScreening.qualityVector.length; i++) {
      vec[qualSeg.start + i] = preScreening.qualityVector[i] * 0.5; // Damped blend
    }
  }

  // Segment 5: Reserved for Borg Queen context (512-767) — zero-initialized

  normalizeVector(vec);
  return vec;
}

/**
 * Apply Borg Queen global context to an intent vector.
 * Updates the reserved segment (512-767) with gap signals.
 */
export function applyBorgQueenContext(
  intentVec: Float32Array,
  context: BorgQueenContext,
): Float32Array {
  const result = new Float32Array(intentVec);
  const seg = INTENT_SEGMENTS.reserved;

  // Blend gap signal into reserved segment
  for (let i = seg.start; i < seg.end && (i - seg.start) < context.gapSignal.length; i++) {
    result[i] = context.gapSignal[i - seg.start] * 0.7;
  }

  normalizeVector(result);
  return result;
}

// ── Mod 5: Pre-Screening Latent Filter ─────────────────────────────────

/**
 * Produce a latent quality signal from pre-screening analysis.
 * Determines quality tier and recommended round allocation.
 */
export function preScreenRepo(
  analysis: Omit<RepoAnalysis, 'approval'>,
): PreScreeningSignal {
  // Score components
  const licenseScore = analysis.compatibility.licenseCompatible ? 100 : 0;
  const maintenanceScore = analysis.quality.maintainerActive ? 100 :
    analysis.quality.lastCommitDate ? 30 : 0;
  const forkabilityScore = analysis.forkability?.forkabilityScore ?? 50;
  const complexityScore = computeComplexityScore(analysis.complexity);

  const weightedScore = (
    licenseScore * 0.30 +
    maintenanceScore * 0.25 +
    forkabilityScore * 0.25 +
    complexityScore * 0.20
  );

  // Determine tier
  let qualityTier: PreScreeningSignal['qualityTier'];
  let recommendedRounds: number;

  if (licenseScore === 0) {
    qualityTier = 'drop';
    recommendedRounds = 0;
  } else if (weightedScore >= 70) {
    qualityTier = 'high';
    recommendedRounds = TIER_ROUND_BUDGETS.high;
  } else if (weightedScore >= 40) {
    qualityTier = 'standard';
    recommendedRounds = TIER_ROUND_BUDGETS.standard;
  } else {
    qualityTier = 'borderline';
    recommendedRounds = TIER_ROUND_BUDGETS.borderline;
  }

  // Build quality vector
  const qualityVector = new Float32Array(LATENT_DIM);
  const segLen = INTENT_SEGMENTS.qualityInit.end - INTENT_SEGMENTS.qualityInit.start;

  // Distribute scores across quality segment
  for (let i = 0; i < segLen; i++) {
    const pos = i / segLen;
    qualityVector[i] =
      (licenseScore / 100) * Math.sin(pos * Math.PI) * 0.3 +
      (maintenanceScore / 100) * Math.cos(pos * Math.PI * 2) * 0.25 +
      (forkabilityScore / 100) * Math.sin(pos * Math.PI * 3) * 0.25 +
      (complexityScore / 100) * Math.cos(pos * Math.PI * 4) * 0.2;
  }

  return {
    qualityTier,
    qualityVector,
    recommendedRounds,
    scores: {
      license: licenseScore,
      maintenance: maintenanceScore,
      forkability: forkabilityScore,
      complexity: complexityScore,
    },
  };
}

function computeComplexityScore(complexity: ComplexityMetrics): number {
  // Lower complexity = higher score (easier to absorb)
  if (complexity.totalFiles < 20) return 100;
  if (complexity.totalFiles < 50) return 80;
  if (complexity.totalFiles < 100) return 60;
  if (complexity.totalFiles < 300) return 40;
  return 20;
}

// ── Mod 3: Latent State Handoff ────────────────────────────────────────

/**
 * Aggregate incoming L1 (GitNexus) and L2 (DeepSec) hidden states
 * into Borg Arc's assessment vector for the current round.
 */
export function aggregateEvaluationSignals(
  currentAssessment: Float32Array,
  l1State?: Float32Array,
  l2State?: Float32Array,
  l2Gate?: GateSignal,
): Float32Array {
  const result = new Float32Array(LATENT_DIM);

  // Start from current assessment
  for (let i = 0; i < LATENT_DIM; i++) {
    result[i] = currentAssessment[i];
  }

  // Blend L1 structural signal into structural segment
  if (l1State) {
    const seg = ASSESSMENT_SEGMENTS.structural;
    for (let i = seg.start; i < seg.end; i++) {
      const l1Idx = i - seg.start;
      if (l1Idx < l1State.length) {
        result[i] = result[i] * 0.4 + l1State[l1Idx] * 0.6; // L1 weighted higher for structure
      }
    }
  }

  // Blend L2 security signal into security segment
  if (l2State) {
    const seg = ASSESSMENT_SEGMENTS.security;
    for (let i = seg.start; i < seg.end; i++) {
      const l2Idx = i - seg.start;
      if (l2Idx < l2State.length) {
        result[i] = result[i] * 0.3 + l2State[l2Idx] * 0.7; // L2 weighted higher for security
      }
    }
  }

  // If L2 gate says fail, spike the security segment
  if (l2Gate && l2Gate.gate === 'fail') {
    const seg = ASSESSMENT_SEGMENTS.security;
    for (let i = seg.start; i < seg.end; i++) {
      result[i] = result[i] * 1.5; // Amplify security concern
    }
  }

  // Cross-signal compatibility: correlation between structural and security
  if (l1State && l2State) {
    const seg = ASSESSMENT_SEGMENTS.compatibility;
    for (let i = seg.start; i < seg.end; i++) {
      const l1Val = l1State[Math.min(i - seg.start, l1State.length - 1)] ?? 0;
      const l2Val = l2State[Math.min(i - seg.start, l2State.length - 1)] ?? 0;
      result[i] = (l1Val + l2Val) * 0.5; // Average as cross-correlation proxy
    }
  }

  normalizeVector(result);
  return result;
}

// ── Mod 4: Multi-Round Acquisition Decision Aggregator ─────────────────

/**
 * Derive a provisional acquisition decision from the current assessment state.
 */
export function deriveDecision(
  assessmentState: Float32Array,
  l2Gate?: GateSignal,
): { decision: 'absorb' | 'skip' | 'review'; confidence: number } {
  // Extract decision segment values
  const seg = ASSESSMENT_SEGMENTS.decision;
  let decisionEnergy = 0;
  for (let i = seg.start; i < seg.end; i++) {
    decisionEnergy += assessmentState[i] * assessmentState[i];
  }
  decisionEnergy = Math.sqrt(decisionEnergy / (seg.end - seg.start));

  // Extract factor segment for confidence
  const fSeg = ASSESSMENT_SEGMENTS.factors;
  let factorEnergy = 0;
  for (let i = fSeg.start; i < fSeg.end; i++) {
    factorEnergy += Math.abs(assessmentState[i]);
  }
  factorEnergy /= (fSeg.end - fSeg.start);

  // Compute structural compatibility from structural segment
  const sSeg = ASSESSMENT_SEGMENTS.structural;
  let structuralMagnitude = 0;
  for (let i = sSeg.start; i < sSeg.end; i++) {
    structuralMagnitude += assessmentState[i] * assessmentState[i];
  }
  structuralMagnitude = Math.sqrt(structuralMagnitude / (sSeg.end - sSeg.start));

  // Compute security risk from security segment
  const secSeg = ASSESSMENT_SEGMENTS.security;
  let securityMagnitude = 0;
  for (let i = secSeg.start; i < secSeg.end; i++) {
    securityMagnitude += assessmentState[i] * assessmentState[i];
  }
  securityMagnitude = Math.sqrt(securityMagnitude / (secSeg.end - secSeg.start));

  // Hard override: L2 gate fail = skip
  if (l2Gate?.gate === 'fail') {
    return { decision: 'skip', confidence: 0.9 };
  }

  // Decision logic
  const confidence = Math.min(1, (decisionEnergy + factorEnergy + structuralMagnitude) / 3);

  // High structural + low security = absorb
  if (structuralMagnitude > 0.15 && securityMagnitude < 0.3 && confidence > 0.4) {
    return { decision: 'absorb', confidence };
  }

  // High security risk = review
  if (securityMagnitude > 0.3 || l2Gate?.gate === 'review') {
    return { decision: 'review', confidence };
  }

  // Low overall energy = skip (not enough positive signal)
  if (confidence < 0.2) {
    return { decision: 'skip', confidence };
  }

  // Default: review (uncertain)
  return { decision: 'review', confidence };
}

/**
 * Run a full multi-round acquisition evaluation for a single repo thread.
 * This is the core RecursiveMAS cluster coordinator for L3.
 */
export function runAcquisitionThread(config: AcquisitionThreadConfig & {
  taskId: string;
  /** Pre-screening signal for quality-aware resource allocation */
  preScreening?: PreScreeningSignal;
  /** L1 GitNexus analysis result (if available) */
  graphAnalysis?: GraphLatentResult;
  /** L2 DeepSec analysis result (if available) */
  scanAnalysis?: ScanLatentResult;
  /** L2 gate signal */
  securityGate?: GateSignal;
  /** Borg Queen context for gap-aware evaluation */
  borgQueenContext?: BorgQueenContext;
}): AcquisitionThreadResult {
  const {
    taskId, threadId, repoUrl, intent, maxRounds,
    preScreening, graphAnalysis, scanAnalysis, securityGate, borgQueenContext,
  } = config;

  // Initialize intent vector
  let intentVec = encodeIntentSignal(intent, preScreening);
  if (borgQueenContext) {
    intentVec = applyBorgQueenContext(intentVec, borgQueenContext);
  }

  // Initialize assessment state from intent
  let assessmentState = new Float32Array(intentVec);

  const tracker = new ConvergenceTracker();
  const rounds: ThreadRoundResult[] = [];
  let converged = false;
  const qualityTier = preScreening?.qualityTier === 'drop' ? 'borderline'
    : (preScreening?.qualityTier ?? 'standard') as 'high' | 'standard' | 'borderline';

  for (let round = 0; round < maxRounds; round++) {
    // Get L1/L2 signals for this round
    // In full integration, these come via Outer Link each round.
    // For now, we use the final states from completed L1/L2 analyses.
    const l1Signal = graphAnalysis?.finalState;
    const l2Signal = scanAnalysis?.finalState;
    const l2Gate = securityGate;

    // Aggregate evaluation signals
    assessmentState = aggregateEvaluationSignals(
      assessmentState, l1Signal, l2Signal, l2Gate,
    ) as Float32Array<ArrayBuffer>;

    // Inject intent bias: blend intent vector back in (diminishing per round)
    const intentWeight = 0.3 * Math.pow(0.7, round); // Decays: 0.3, 0.21, 0.147...
    for (let i = 0; i < LATENT_DIM; i++) {
      assessmentState[i] = assessmentState[i] * (1 - intentWeight) + intentVec[i] * intentWeight;
    }
    normalizeVector(assessmentState);

    // Encode decision factors into decision segment
    const { decision: provisional, confidence } = deriveDecision(assessmentState, l2Gate);

    // Update decision segment with derived values
    const dSeg = ASSESSMENT_SEGMENTS.decision;
    for (let i = dSeg.start; i < dSeg.end; i++) {
      const pos = (i - dSeg.start) / (dSeg.end - dSeg.start);
      assessmentState[i] = confidence * Math.sin(pos * Math.PI * 2 +
        (provisional === 'absorb' ? 0 : provisional === 'review' ? Math.PI / 2 : Math.PI));
    }
    normalizeVector(assessmentState);

    // Check convergence
    const conv = tracker.update(`borgarc_${threadId}`, assessmentState);
    converged = conv.converged;

    // Write trace
    writeTrace({
      agentId: 'borg-arc',
      layer: 'L3',
      round,
      hiddenState: assessmentState,
      convergenceDelta: conv.delta,
      metadata: {
        dim: assessmentState.length,
        timestamp: new Date().toISOString(),
        taskId,
      },
    });

    rounds.push({
      round,
      assessmentState: new Float32Array(assessmentState),
      convergenceDelta: conv.delta,
      provisionalDecision: provisional,
      confidenceLevel: confidence,
      l1Signal: l1Signal ? new Float32Array(l1Signal) : undefined,
      l2Signal: l2Signal ? new Float32Array(l2Signal) : undefined,
      l2Gate,
    });

    // Early exit on convergence
    if (converged && round >= 1) break;
  }

  const lastRound = rounds[rounds.length - 1];
  return {
    threadId,
    repoUrl,
    rounds,
    converged,
    finalDecision: lastRound.provisionalDecision,
    finalConfidence: lastRound.confidenceLevel,
    finalState: new Float32Array(assessmentState),
    qualityTier,
  };
}

// ── Mod 1: Parallel Acquisition Thread Manager ─────────────────────────

/**
 * Manage parallel acquisition threads for batch repo evaluation.
 * Allocates threads based on pre-screening quality tiers.
 */
export function planAcquisitionBatch(
  candidates: Array<{
    repoUrl: string;
    repoPath: string;
    analysis: Omit<RepoAnalysis, 'approval'>;
    intent: AcquisitionIntent;
  }>,
  maxThreads: number = DEFAULT_THREAD_COUNT,
): Array<AcquisitionThreadConfig & { preScreening: PreScreeningSignal }> {
  // Pre-screen all candidates
  const screened = candidates.map((c) => ({
    ...c,
    preScreening: preScreenRepo(c.analysis),
  }));

  // Filter drops
  const viable = screened.filter((s) => s.preScreening.qualityTier !== 'drop');

  // Sort by quality tier (high first) then by recommended rounds (more rounds = higher priority)
  viable.sort((a, b) => {
    const tierOrder = { high: 0, standard: 1, borderline: 2 };
    const tierDiff = tierOrder[a.preScreening.qualityTier as keyof typeof tierOrder]
      - tierOrder[b.preScreening.qualityTier as keyof typeof tierOrder];
    if (tierDiff !== 0) return tierDiff;
    return b.preScreening.recommendedRounds - a.preScreening.recommendedRounds;
  });

  // Allocate thread configs (up to maxThreads)
  const batch = viable.slice(0, maxThreads);

  return batch.map((c, idx) => ({
    threadId: `acq-${idx}-${Date.now()}`,
    repoUrl: c.repoUrl,
    repoPath: c.repoPath,
    intent: c.intent,
    maxRounds: c.preScreening.recommendedRounds,
    preScreening: c.preScreening,
  }));
}

// ── Mod 6: Borg Queen Reporting Interface ──────────────────────────────

/**
 * Package a completed acquisition thread result as a report for Borg Queen.
 */
export function createBorgQueenReport(
  threadResult: AcquisitionThreadResult,
  intent: AcquisitionIntent,
): BorgQueenReport {
  // Extract key factors from final state
  const state = threadResult.finalState;

  const structuralSeg = ASSESSMENT_SEGMENTS.structural;
  let structuralCompat = 0;
  for (let i = structuralSeg.start; i < structuralSeg.end; i++) {
    structuralCompat += state[i] * state[i];
  }
  structuralCompat = Math.sqrt(structuralCompat / (structuralSeg.end - structuralSeg.start));

  const securitySeg = ASSESSMENT_SEGMENTS.security;
  let securityRisk = 0;
  for (let i = securitySeg.start; i < securitySeg.end; i++) {
    securityRisk += state[i] * state[i];
  }
  securityRisk = Math.sqrt(securityRisk / (securitySeg.end - securitySeg.start));

  const compatSeg = ASSESSMENT_SEGMENTS.compatibility;
  let integrationComplexity = 0;
  for (let i = compatSeg.start; i < compatSeg.end; i++) {
    integrationComplexity += Math.abs(state[i]);
  }
  integrationComplexity /= (compatSeg.end - compatSeg.start);

  // Value alignment: how well does this match the intent?
  const factorSeg = ASSESSMENT_SEGMENTS.factors;
  let valueAlignment = 0;
  for (let i = factorSeg.start; i < factorSeg.end; i++) {
    valueAlignment += state[i] * state[i];
  }
  valueAlignment = Math.sqrt(valueAlignment / (factorSeg.end - factorSeg.start));

  return {
    threadId: threadResult.threadId,
    repoUrl: threadResult.repoUrl,
    decision: threadResult.finalDecision,
    confidence: threadResult.finalConfidence,
    hiddenState: new Float32Array(state),
    factors: {
      structuralCompatibility: structuralCompat,
      securityRisk,
      integrationComplexity,
      valueAlignment,
    },
    targetLayer: intent.targetLayer,
  };
}

/**
 * Create a LatentPayload for Borg Queen dispatch.
 */
export function createBorgArcPayload(hiddenState: Float32Array): LatentPayload {
  return {
    data: hiddenState.slice() as Float32Array<ArrayBuffer>,
    numVectors: 1,
    dim: LATENT_DIM,
    adapterKey: 'borgarc_L3_acquisition',
    sourceHiddenSize: LATENT_DIM,
  };
}

/**
 * Create a LatentPayload specifically for Borg Queen reporting.
 */
export function createBorgQueenPayload(report: BorgQueenReport): LatentPayload {
  return {
    data: report.hiddenState.slice() as Float32Array<ArrayBuffer>,
    numVectors: 1,
    dim: LATENT_DIM,
    adapterKey: 'borgarc_L3_to_borgqueen',
    sourceHiddenSize: LATENT_DIM,
  };
}

// ── Utility ────────────────────────────────────────────────────────────

function normalizeVector(vec: Float32Array): void {
  let mag = 0;
  for (let i = 0; i < vec.length; i++) {
    mag += vec[i] * vec[i];
  }
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= mag;
    }
  }
}
