/**
 * Hermes Layer 4 - Reflective Phase
 *
 * Implements the deliberation topology's reflector/toolcaller pattern
 * for trace-based recursive reflection. Instead of consuming final text,
 * the Reflective Phase reads trace sequences (hidden states + convergence
 * deltas) to understand reasoning paths and identify patterns.
 *
 * Maps to RecursiveMAS:
 *   - Reflector agent = reads traces, identifies reasoning gaps
 *   - Toolcaller agent = executes actions based on reflection output
 *   - outer_rt / outer_tr = bidirectional latent exchange
 *   - max_tool_rounds = reflection depth budget
 *
 * Reflection depths (locked):
 *   - Light  = 2 rounds (quick self-check)
 *   - Standard = 4 rounds (full analysis)
 *   - Deep   = 8 rounds (exhaustive, security/high-risk)
 */

import crypto from 'crypto';

import { logger } from '../logger.js';

import { readTraces, writeTrace } from './trace.js';
import { checkConvergence, ConvergenceTracker } from './transport.js';
import { decodeFloat32 } from './trace.js';
import type { TraceEntry, HermesMessage, LatentPayload } from './types.js';
import { LATENT_DIM } from './types.js';

// ── Reflection Depth ────────────────────────────────────────────────

export type ReflectionDepth = 'light' | 'standard' | 'deep';

export const REFLECTION_ROUNDS: Record<ReflectionDepth, number> = {
  light: 2,
  standard: 4,
  deep: 8,
};

/** Infer reflection depth from task context. */
export function inferReflectionDepth(opts: {
  layer?: string;
  isSecurityAdjacent?: boolean;
  isHighRisk?: boolean;
  explicit?: ReflectionDepth;
}): ReflectionDepth {
  if (opts.explicit) return opts.explicit;
  if (opts.isSecurityAdjacent || opts.isHighRisk) return 'deep';
  if (opts.layer === 'L2' || opts.layer === 'L3') return 'standard';
  return 'light';
}

// ── Trace Analysis ──────────────────────────────────────────────────

/** Result of analyzing a trace sequence. */
export interface TraceAnalysis {
  /** Task being analyzed */
  taskId: string;
  /** Total rounds found in trace */
  totalRounds: number;
  /** Per-agent convergence trajectory */
  convergenceTrajectory: Array<{
    agentId: string;
    round: number;
    delta: number | null;
  }>;
  /** Whether the task reached convergence */
  reachedConvergence: boolean;
  /** Final convergence delta (lowest across agents) */
  finalDelta: number | null;
  /** Agents involved */
  agents: string[];
  /** Layers touched */
  layers: string[];
  /** Anomalies detected (divergence, oscillation, stagnation) */
  anomalies: TraceAnomaly[];
}

export type AnomalyType =
  | 'divergence'       // delta increasing between rounds
  | 'oscillation'      // delta alternating up/down
  | 'stagnation'       // delta not decreasing but not converged
  | 'dimension_mismatch' // unexpected dim in trace
  | 'missing_rounds';  // gaps in round sequence

export interface TraceAnomaly {
  type: AnomalyType;
  agentId: string;
  round: number;
  detail: string;
  severity: 'info' | 'warn' | 'error';
}

/**
 * Analyze a task's trace sequence for patterns and anomalies.
 * This is what the Reflective Phase "reads" instead of final text.
 */
export function analyzeTraces(taskId: string): TraceAnalysis {
  const traces = readTraces(taskId);

  if (traces.length === 0) {
    return {
      taskId,
      totalRounds: 0,
      convergenceTrajectory: [],
      reachedConvergence: false,
      finalDelta: null,
      agents: [],
      layers: [],
      anomalies: [],
    };
  }

  const agents = [...new Set(traces.map((t) => t.agentId))];
  const layers = [...new Set(traces.map((t) => t.layer))];
  const maxRound = Math.max(...traces.map((t) => t.round));

  const trajectory: TraceAnalysis['convergenceTrajectory'] = traces.map((t) => ({
    agentId: t.agentId,
    round: t.round,
    delta: t.convergenceDelta,
  }));

  // Detect anomalies
  const anomalies: TraceAnomaly[] = [];
  const byAgent = new Map<string, typeof traces>();
  for (const t of traces) {
    const arr = byAgent.get(t.agentId) ?? [];
    arr.push(t);
    byAgent.set(t.agentId, arr);
  }

  for (const [agentId, agentTraces] of byAgent) {
    const sorted = agentTraces.sort((a, b) => a.round - b.round);

    // Check for round gaps
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].round - sorted[i - 1].round > 1) {
        anomalies.push({
          type: 'missing_rounds',
          agentId,
          round: sorted[i - 1].round,
          detail: `Gap: round ${sorted[i - 1].round} -> ${sorted[i].round}`,
          severity: 'warn',
        });
      }
    }

    // Check convergence trajectory
    const deltas = sorted
      .filter((t) => t.convergenceDelta !== null)
      .map((t) => ({ round: t.round, delta: t.convergenceDelta! }));

    for (let i = 1; i < deltas.length; i++) {
      const prev = deltas[i - 1].delta;
      const curr = deltas[i].delta;

      if (curr > prev * 1.1) {
        anomalies.push({
          type: 'divergence',
          agentId,
          round: deltas[i].round,
          detail: `Delta increased: ${prev.toFixed(4)} -> ${curr.toFixed(4)}`,
          severity: 'warn',
        });
      }
    }

    // Oscillation check: 3+ alternating increases/decreases
    if (deltas.length >= 4) {
      let alternations = 0;
      for (let i = 2; i < deltas.length; i++) {
        const d0 = deltas[i - 2].delta;
        const d1 = deltas[i - 1].delta;
        const d2 = deltas[i].delta;
        if ((d1 > d0 && d2 < d1) || (d1 < d0 && d2 > d1)) {
          alternations++;
        }
      }
      if (alternations >= 2) {
        anomalies.push({
          type: 'oscillation',
          agentId,
          round: deltas[deltas.length - 1].round,
          detail: `${alternations} alternations in convergence trajectory`,
          severity: 'warn',
        });
      }
    }

    // Stagnation: last 3 deltas within 0.001 of each other but above threshold
    if (deltas.length >= 3) {
      const last3 = deltas.slice(-3).map((d) => d.delta);
      const range = Math.max(...last3) - Math.min(...last3);
      if (range < 0.001 && last3[0] >= 0.02) {
        anomalies.push({
          type: 'stagnation',
          agentId,
          round: deltas[deltas.length - 1].round,
          detail: `Delta plateau at ~${last3[0].toFixed(4)} (above threshold)`,
          severity: 'info',
        });
      }
    }

    // Dimension check
    for (const t of sorted) {
      if (t.metadata.dim !== LATENT_DIM) {
        anomalies.push({
          type: 'dimension_mismatch',
          agentId,
          round: t.round,
          detail: `Expected dim=${LATENT_DIM}, got ${t.metadata.dim}`,
          severity: 'error',
        });
      }
    }
  }

  // Final convergence status
  const lastDeltas = traces
    .filter((t) => t.convergenceDelta !== null)
    .sort((a, b) => b.round - a.round);
  const finalDelta = lastDeltas.length > 0 ? lastDeltas[0].convergenceDelta : null;
  const reachedConvergence = finalDelta !== null && finalDelta < 0.02;

  return {
    taskId,
    totalRounds: maxRound + 1,
    convergenceTrajectory: trajectory,
    reachedConvergence,
    finalDelta,
    agents,
    layers,
    anomalies,
  };
}

// ── Reflection Session ──────────────────────────────────────────────

/** Input to a reflection session. */
export interface ReflectionInput {
  /** Task to reflect on */
  taskId: string;
  /** Which agent is reflecting */
  reflectorAgentId: string;
  /** Reflection depth */
  depth: ReflectionDepth;
  /** Optional: specific layer to focus on */
  focusLayer?: TraceEntry['layer'];
  /** Optional: parent trace for chaining reflections */
  parentTraceId?: string;
}

/** A single reflection round's output. */
export interface ReflectionRound {
  round: number;
  /** Analysis of the trace state at this point */
  analysis: TraceAnalysis;
  /** What the reflector "saw" -- summary of patterns */
  observations: string[];
  /** Actions recommended based on observations */
  recommendations: ReflectionAction[];
  /** Convergence state of the reflection itself */
  convergenceDelta: number | null;
  /** Trace entry for this reflection round */
  traceId: string;
}

export type ReflectionActionType =
  | 'continue'       // more rounds needed
  | 'converged'      // task reached convergence, stop
  | 'escalate'       // anomaly needs attention
  | 'adjust_depth'   // change reflection depth
  | 'retry_round'    // specific round should be retried
  | 'inject_feedback'; // feed specific latent back to source agent

export interface ReflectionAction {
  type: ReflectionActionType;
  detail: string;
  /** Target agent for inject_feedback */
  targetAgent?: string;
  /** Target round for retry_round */
  targetRound?: number;
}

/** Full result of a reflection session. */
export interface ReflectionResult {
  taskId: string;
  reflectorAgentId: string;
  depth: ReflectionDepth;
  maxRounds: number;
  roundsExecuted: number;
  rounds: ReflectionRound[];
  /** Overall reflection converged? */
  reflectionConverged: boolean;
  /** Final recommendations from last round */
  finalActions: ReflectionAction[];
  /** Total anomalies detected across all rounds */
  totalAnomalies: number;
}

/**
 * Run a Reflective Phase session.
 *
 * Mirrors RecursiveMAS deliberation topology:
 *   - Each round reads current trace state
 *   - Analyzes convergence trajectory + anomalies
 *   - Generates observations + recommendations
 *   - Writes own trace (reflection traces are L4-tagged)
 *   - Checks if reflection itself has converged
 *   - Stops when converged or max rounds hit
 */
export function runReflection(input: ReflectionInput): ReflectionResult {
  const maxRounds = REFLECTION_ROUNDS[input.depth];
  const tracker = new ConvergenceTracker();
  const rounds: ReflectionRound[] = [];

  logger.info(
    {
      taskId: input.taskId,
      reflector: input.reflectorAgentId,
      depth: input.depth,
      maxRounds,
    },
    'Hermes: starting Reflective Phase',
  );

  for (let r = 0; r < maxRounds; r++) {
    // 1. Analyze current trace state
    const analysis = analyzeTraces(input.taskId);

    // 2. Generate observations from analysis
    const observations = generateObservations(analysis, input.focusLayer);

    // 3. Generate actions from observations
    const recommendations = generateRecommendations(analysis, observations, r, maxRounds);

    // 4. Create a synthetic hidden state for this reflection round
    //    (mean of all trace hidden states, representing "understanding")
    const reflectionState = computeReflectionState(input.taskId);

    // 5. Check reflection convergence
    const convResult = tracker.update(input.reflectorAgentId, reflectionState);

    // 6. Write reflection trace
    const trace = writeTrace({
      agentId: input.reflectorAgentId,
      layer: 'L4',
      round: r,
      hiddenState: reflectionState,
      convergenceDelta: convResult.delta,
      metadata: {
        dim: reflectionState.length,
        timestamp: new Date().toISOString(),
        taskId: input.taskId,
        parentTraceId: input.parentTraceId,
      },
    });

    const roundResult: ReflectionRound = {
      round: r,
      analysis,
      observations,
      recommendations,
      convergenceDelta: convResult.delta,
      traceId: trace.id,
    };
    rounds.push(roundResult);

    logger.debug(
      {
        round: r,
        anomalies: analysis.anomalies.length,
        observations: observations.length,
        delta: convResult.delta,
      },
      'Hermes: reflection round complete',
    );

    // 7. Check if reflection has converged or should stop
    if (convResult.converged) {
      logger.info(
        { round: r, delta: convResult.delta },
        'Hermes: reflection converged',
      );
      break;
    }

    // Early exit if task already converged and no anomalies
    if (analysis.reachedConvergence && analysis.anomalies.length === 0 && r >= 1) {
      logger.info({ round: r }, 'Hermes: task converged, no anomalies, stopping early');
      break;
    }
  }

  const lastRound = rounds[rounds.length - 1];

  return {
    taskId: input.taskId,
    reflectorAgentId: input.reflectorAgentId,
    depth: input.depth,
    maxRounds,
    roundsExecuted: rounds.length,
    rounds,
    reflectionConverged: lastRound?.convergenceDelta !== null && lastRound.convergenceDelta < 0.02,
    finalActions: lastRound?.recommendations ?? [],
    totalAnomalies: rounds.reduce((sum, r) => sum + r.analysis.anomalies.length, 0),
  };
}

// ── Internal Helpers ────────────────────────────────────────────────

/**
 * Compute mean hidden state from all traces for a task.
 * Represents the reflection's "understanding" of the task state.
 * Falls back to zero vector if no traces exist.
 */
function computeReflectionState(taskId: string): Float32Array {
  const traces = readTraces(taskId);
  const state = new Float32Array(LATENT_DIM);

  if (traces.length === 0) return state;

  let count = 0;
  for (const t of traces) {
    const vec = decodeFloat32(t.hiddenState);
    // Only accumulate vectors matching LATENT_DIM
    if (vec.length === LATENT_DIM) {
      for (let i = 0; i < LATENT_DIM; i++) {
        state[i] += vec[i];
      }
      count++;
    }
  }

  if (count > 0) {
    for (let i = 0; i < LATENT_DIM; i++) {
      state[i] /= count;
    }
  }

  return state;
}

/** Generate human-readable observations from trace analysis. */
function generateObservations(
  analysis: TraceAnalysis,
  focusLayer?: TraceEntry['layer'],
): string[] {
  const obs: string[] = [];

  if (analysis.totalRounds === 0) {
    obs.push('No traces found for this task');
    return obs;
  }

  obs.push(`${analysis.totalRounds} rounds across ${analysis.agents.length} agents (${analysis.agents.join(', ')})`);
  obs.push(`Layers: ${analysis.layers.join(', ')}`);

  if (analysis.reachedConvergence) {
    obs.push(`Converged with delta=${analysis.finalDelta?.toFixed(4)}`);
  } else {
    obs.push(`Not converged. Final delta=${analysis.finalDelta?.toFixed(4) ?? 'unknown'}`);
  }

  // Anomaly observations
  const byType = new Map<string, TraceAnomaly[]>();
  for (const a of analysis.anomalies) {
    const arr = byType.get(a.type) ?? [];
    arr.push(a);
    byType.set(a.type, arr);
  }

  if (byType.has('divergence')) {
    const divs = byType.get('divergence')!;
    obs.push(`DIVERGENCE detected in ${divs.length} round(s): ${divs.map((d) => `${d.agentId}@r${d.round}`).join(', ')}`);
  }

  if (byType.has('oscillation')) {
    obs.push('OSCILLATION pattern detected -- convergence trajectory unstable');
  }

  if (byType.has('stagnation')) {
    obs.push('STAGNATION detected -- delta plateaued above threshold');
  }

  if (byType.has('dimension_mismatch')) {
    obs.push('DIMENSION MISMATCH -- trace contains non-standard vectors');
  }

  // Focus layer filter
  if (focusLayer) {
    const layerTraces = analysis.convergenceTrajectory.filter(
      (t) => analysis.layers.includes(focusLayer),
    );
    obs.push(`Focus layer ${focusLayer}: ${layerTraces.length} trajectory entries`);
  }

  return obs;
}

/** Generate action recommendations from analysis and observations. */
function generateRecommendations(
  analysis: TraceAnalysis,
  observations: string[],
  currentRound: number,
  maxRounds: number,
): ReflectionAction[] {
  const actions: ReflectionAction[] = [];

  // Already converged, no issues
  if (analysis.reachedConvergence && analysis.anomalies.length === 0) {
    actions.push({ type: 'converged', detail: 'Task converged successfully' });
    return actions;
  }

  // Handle anomalies
  const errors = analysis.anomalies.filter((a) => a.severity === 'error');
  if (errors.length > 0) {
    actions.push({
      type: 'escalate',
      detail: `${errors.length} error-level anomalies: ${errors.map((e) => e.type).join(', ')}`,
    });
  }

  // Divergence: recommend retry
  const divergences = analysis.anomalies.filter((a) => a.type === 'divergence');
  for (const div of divergences) {
    actions.push({
      type: 'retry_round',
      detail: `Divergence at ${div.agentId} round ${div.round}`,
      targetAgent: div.agentId,
      targetRound: div.round,
    });
  }

  // Oscillation: recommend depth increase
  if (analysis.anomalies.some((a) => a.type === 'oscillation')) {
    actions.push({
      type: 'adjust_depth',
      detail: 'Oscillation detected -- consider deeper reflection',
    });
  }

  // Stagnation: inject feedback to break plateau
  const stagnations = analysis.anomalies.filter((a) => a.type === 'stagnation');
  for (const stag of stagnations) {
    actions.push({
      type: 'inject_feedback',
      detail: `Stagnation at ${stag.agentId} -- inject perturbation`,
      targetAgent: stag.agentId,
    });
  }

  // Not converged, more rounds available
  if (!analysis.reachedConvergence && currentRound < maxRounds - 1) {
    actions.push({ type: 'continue', detail: `Round ${currentRound + 1}/${maxRounds}` });
  }

  return actions;
}

// ── Skill File Integration ──────────────────────────────────────────

/**
 * Summarize a reflection result for skill file writing.
 * Returns structured data that the latent skill file writer (Step 4) consumes.
 */
export interface ReflectionSkillSummary {
  taskId: string;
  reflectorAgentId: string;
  depth: ReflectionDepth;
  roundsExecuted: number;
  converged: boolean;
  finalDelta: number | null;
  anomalyCount: number;
  anomalyTypes: string[];
  actionTypes: string[];
  /** Mean hidden state from reflection (for latent skill file) */
  meanHiddenState: Float32Array;
}

export function summarizeForSkillFile(result: ReflectionResult): ReflectionSkillSummary {
  const allAnomalyTypes = new Set<string>();
  const allActionTypes = new Set<string>();
  for (const r of result.rounds) {
    for (const a of r.analysis.anomalies) allAnomalyTypes.add(a.type);
    for (const a of r.recommendations) allActionTypes.add(a.type);
  }

  return {
    taskId: result.taskId,
    reflectorAgentId: result.reflectorAgentId,
    depth: result.depth,
    roundsExecuted: result.roundsExecuted,
    converged: result.reflectionConverged,
    finalDelta: result.rounds[result.rounds.length - 1]?.convergenceDelta ?? null,
    anomalyCount: result.totalAnomalies,
    anomalyTypes: [...allAnomalyTypes],
    actionTypes: [...allActionTypes],
    meanHiddenState: computeReflectionState(result.taskId),
  };
}
