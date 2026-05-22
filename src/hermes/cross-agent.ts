/**
 * Hermes Layer 4 - Cross-Agent Correlation
 *
 * Step 7: Team-level skill accumulation from multi-agent trace correlation.
 *
 * Reads traces across agents sharing a taskId, computes pairwise latent
 * similarity, detects convergence clusters and divergent outliers, and
 * produces a correlation matrix that feeds into inject_feedback decisions.
 *
 * Architecture:
 *   1. Pull all traces for a task → group by agent
 *   2. For each agent pair, compute cosine similarity of final-round hidden states
 *   3. Build NxN correlation matrix
 *   4. Identify clusters (agents converging together) and outliers
 *   5. Generate perturbation vectors for stagnant agents using correlated peers
 */

import { logger } from '../logger.js';

import { readTraces, deserializeTrace, writeTrace, type SerializedTrace } from './trace.js';
import { cosineSimilarity } from './transport.js';
import type { TraceEntry } from './types.js';
import { LATENT_DIM } from './types.js';
import type { ReflectionAction } from './reflective-phase.js';

// ── Types ──────────────────────────────────────────────────────────

/** Pairwise correlation between two agents. */
export interface AgentCorrelation {
  agentA: string;
  agentB: string;
  /** Cosine similarity of final-round hidden states (0-1) */
  similarity: number;
  /** Both agents on same round? */
  roundAligned: boolean;
  /** Round used for comparison */
  comparedAtRound: number;
}

/** A cluster of correlated agents. */
export interface ConvergenceCluster {
  /** Cluster ID */
  id: number;
  /** Agent IDs in this cluster */
  agents: string[];
  /** Average pairwise similarity within cluster */
  avgSimilarity: number;
}

/** Full correlation analysis result. */
export interface CorrelationResult {
  taskId: string;
  /** Number of agents analyzed */
  agentCount: number;
  /** All pairwise correlations */
  correlations: AgentCorrelation[];
  /** Detected convergence clusters (similarity > threshold) */
  clusters: ConvergenceCluster[];
  /** Agents not in any cluster (outliers / divergent) */
  outliers: string[];
  /** Mean similarity across all pairs */
  meanSimilarity: number;
  /** Timestamp of analysis */
  analyzedAt: string;
}

/** Perturbation vector for breaking stagnation. */
export interface PerturbationVector {
  /** Target agent to receive perturbation */
  targetAgent: string;
  /** Source agent whose state informs the perturbation direction */
  sourceAgent: string;
  /** The perturbation: blend of noise + directional signal from source */
  vector: Float32Array;
  /** Perturbation magnitude (L2 norm) */
  magnitude: number;
  /** Why this perturbation was generated */
  reason: string;
}

// ── Constants ──────────────────────────────────────────────────────

/** Minimum similarity to consider two agents "correlated" */
const CLUSTER_THRESHOLD = 0.85;

/** Perturbation blend: how much of the directional signal vs random noise */
const PERTURBATION_SIGNAL_WEIGHT = 0.7;
const PERTURBATION_NOISE_WEIGHT = 0.3;

/** Perturbation magnitude scale factor */
const PERTURBATION_SCALE = 0.05;

// ── Core Analysis ──────────────────────────────────────────────────

/**
 * Get the final-round hidden state for each agent in a task's traces.
 */
function getFinalStates(traces: SerializedTrace[]): Map<string, TraceEntry> {
  const byAgent = new Map<string, SerializedTrace[]>();
  for (const t of traces) {
    const arr = byAgent.get(t.agentId) ?? [];
    arr.push(t);
    byAgent.set(t.agentId, arr);
  }

  const finals = new Map<string, TraceEntry>();
  for (const [agentId, agentTraces] of byAgent) {
    // Pick highest round
    const sorted = agentTraces.sort((a, b) => b.round - a.round);
    finals.set(agentId, deserializeTrace(sorted[0]));
  }
  return finals;
}

/**
 * Compute pairwise correlations between all agents in a task.
 */
export function computeCorrelations(taskId: string): CorrelationResult {
  const traces = readTraces(taskId);

  if (traces.length === 0) {
    return {
      taskId,
      agentCount: 0,
      correlations: [],
      clusters: [],
      outliers: [],
      meanSimilarity: 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  const finals = getFinalStates(traces);
  const agents = [...finals.keys()].sort();

  if (agents.length < 2) {
    return {
      taskId,
      agentCount: agents.length,
      correlations: [],
      clusters: agents.length === 1 ? [{ id: 0, agents, avgSimilarity: 1 }] : [],
      outliers: [],
      meanSimilarity: 1,
      analyzedAt: new Date().toISOString(),
    };
  }

  // Pairwise similarity
  const correlations: AgentCorrelation[] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = finals.get(agents[i])!;
      const b = finals.get(agents[j])!;

      // Ensure same dimensionality — truncate to min if mismatched
      const dimA = a.hiddenState.length;
      const dimB = b.hiddenState.length;
      let sim: number;

      if (dimA === dimB) {
        sim = cosineSimilarity(a.hiddenState, b.hiddenState);
      } else {
        const minDim = Math.min(dimA, dimB);
        sim = cosineSimilarity(
          a.hiddenState.subarray(0, minDim),
          b.hiddenState.subarray(0, minDim),
        );
        logger.warn(
          { agentA: agents[i], agentB: agents[j], dimA, dimB },
          'Cross-agent correlation: dimension mismatch, truncated',
        );
      }

      correlations.push({
        agentA: agents[i],
        agentB: agents[j],
        similarity: sim,
        roundAligned: a.round === b.round,
        comparedAtRound: Math.min(a.round, b.round),
      });
    }
  }

  // Cluster detection via simple threshold-based union-find
  const clusters = findClusters(agents, correlations);

  // Outliers: agents not in any cluster
  const clusteredAgents = new Set(clusters.flatMap((c) => c.agents));
  const outliers = agents.filter((a) => !clusteredAgents.has(a));

  // Mean similarity
  const meanSimilarity =
    correlations.length > 0
      ? correlations.reduce((sum, c) => sum + c.similarity, 0) / correlations.length
      : 0;

  const result: CorrelationResult = {
    taskId,
    agentCount: agents.length,
    correlations,
    clusters,
    outliers,
    meanSimilarity,
    analyzedAt: new Date().toISOString(),
  };

  logger.info(
    {
      taskId,
      agents: agents.length,
      clusters: clusters.length,
      outliers: outliers.length,
      meanSim: meanSimilarity.toFixed(4),
    },
    'Cross-agent correlation computed',
  );

  return result;
}

// ── Cluster Detection ──────────────────────────────────────────────

/**
 * Simple union-find clustering: agents with pairwise similarity > threshold
 * are merged into the same cluster.
 */
function findClusters(
  agents: string[],
  correlations: AgentCorrelation[],
): ConvergenceCluster[] {
  // Union-find
  const parent = new Map<string, string>();
  for (const a of agents) parent.set(a, a);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Merge agents above threshold
  for (const corr of correlations) {
    if (corr.similarity >= CLUSTER_THRESHOLD) {
      union(corr.agentA, corr.agentB);
    }
  }

  // Group by root
  const groups = new Map<string, string[]>();
  for (const a of agents) {
    const root = find(a);
    const arr = groups.get(root) ?? [];
    arr.push(a);
    groups.set(root, arr);
  }

  // Only clusters with 2+ members
  const clusters: ConvergenceCluster[] = [];
  let id = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;

    // Average intra-cluster similarity
    let sumSim = 0;
    let count = 0;
    for (const corr of correlations) {
      if (members.includes(corr.agentA) && members.includes(corr.agentB)) {
        sumSim += corr.similarity;
        count++;
      }
    }

    clusters.push({
      id: id++,
      agents: members.sort(),
      avgSimilarity: count > 0 ? sumSim / count : 1,
    });
  }

  return clusters;
}

// ── Perturbation Generation ────────────────────────────────────────

/**
 * Generate a perturbation vector to break stagnation at a target agent.
 *
 * Strategy: blend random noise with a directional signal from the most
 * correlated peer agent. The directional signal is the difference vector
 * (peer_state - target_state), encouraging the stagnant agent to move
 * toward a successful neighbor's latent space region.
 */
export function generatePerturbation(
  taskId: string,
  targetAgent: string,
  correlationResult?: CorrelationResult,
): PerturbationVector | null {
  const traces = readTraces(taskId);
  const finals = getFinalStates(traces);
  const targetState = finals.get(targetAgent);

  if (!targetState) {
    logger.warn({ taskId, targetAgent }, 'Cannot generate perturbation: no trace for target');
    return null;
  }

  const dim = targetState.hiddenState.length;

  // Find best correlated peer (not self)
  const corr = correlationResult ?? computeCorrelations(taskId);
  const peerCorr = corr.correlations
    .filter((c) => c.agentA === targetAgent || c.agentB === targetAgent)
    .sort((a, b) => b.similarity - a.similarity);

  let sourceAgent: string | undefined;
  let sourceState: TraceEntry | undefined;

  for (const pc of peerCorr) {
    const peer = pc.agentA === targetAgent ? pc.agentB : pc.agentA;
    const peerState = finals.get(peer);
    if (peerState) {
      sourceAgent = peer;
      sourceState = peerState;
      break;
    }
  }

  // Build perturbation vector
  const perturbation = new Float32Array(dim);

  if (sourceState && sourceState.hiddenState.length === dim) {
    // Directional signal: difference vector (source - target)
    const direction = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      direction[i] = sourceState.hiddenState[i] - targetState.hiddenState[i];
    }

    // Normalize direction
    let dirNorm = 0;
    for (let i = 0; i < dim; i++) dirNorm += direction[i] * direction[i];
    dirNorm = Math.sqrt(dirNorm);
    if (dirNorm > 0) {
      for (let i = 0; i < dim; i++) direction[i] /= dirNorm;
    }

    // Random noise (seeded from taskId for reproducibility)
    const noise = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      noise[i] = (Math.random() - 0.5) * 2;
    }
    let noiseNorm = 0;
    for (let i = 0; i < dim; i++) noiseNorm += noise[i] * noise[i];
    noiseNorm = Math.sqrt(noiseNorm);
    if (noiseNorm > 0) {
      for (let i = 0; i < dim; i++) noise[i] /= noiseNorm;
    }

    // Blend: signal + noise, scaled
    for (let i = 0; i < dim; i++) {
      perturbation[i] =
        (PERTURBATION_SIGNAL_WEIGHT * direction[i] +
          PERTURBATION_NOISE_WEIGHT * noise[i]) *
        PERTURBATION_SCALE;
    }
  } else {
    // No peer: pure random perturbation
    for (let i = 0; i < dim; i++) {
      perturbation[i] = ((Math.random() - 0.5) * 2 * PERTURBATION_SCALE) / Math.sqrt(dim);
    }
    sourceAgent = 'noise';
  }

  // Compute magnitude
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += perturbation[i] * perturbation[i];
  mag = Math.sqrt(mag);

  return {
    targetAgent,
    sourceAgent: sourceAgent ?? 'noise',
    vector: perturbation,
    magnitude: mag,
    reason: sourceAgent && sourceAgent !== 'noise'
      ? `Directional perturbation from correlated peer ${sourceAgent}`
      : 'Random perturbation (no correlated peer available)',
  };
}

// ── Feedback Executor ──────────────────────────────────────────────

/** Result of executing an inject_feedback action. */
export interface FeedbackExecutionResult {
  /** The original action */
  action: ReflectionAction;
  /** Whether feedback was successfully generated and applied */
  success: boolean;
  /** Perturbation details (if successful) */
  perturbation?: PerturbationVector;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Execute an inject_feedback action from the Reflective Phase.
 *
 * This is the missing handler: when reflection detects stagnation,
 * it recommends inject_feedback. This function generates and applies
 * the perturbation to the target agent's latent state.
 *
 * "Applying" means writing a new trace entry with the perturbed state,
 * which downstream rounds will read as the agent's updated position.
 */
export function executeFeedbackAction(
  taskId: string,
  action: ReflectionAction,
  correlationResult?: CorrelationResult,
): FeedbackExecutionResult {
  if (action.type !== 'inject_feedback') {
    return { action, success: false, error: `Not an inject_feedback action: ${action.type}` };
  }

  if (!action.targetAgent) {
    return { action, success: false, error: 'No targetAgent specified' };
  }

  const perturbation = generatePerturbation(taskId, action.targetAgent, correlationResult);

  if (!perturbation) {
    return {
      action,
      success: false,
      error: `Could not generate perturbation for ${action.targetAgent}`,
    };
  }

  // Read current state to apply perturbation
  const traces = readTraces(taskId);
  const agentTraces = traces
    .filter((t) => t.agentId === action.targetAgent)
    .sort((a, b) => b.round - a.round);

  if (agentTraces.length === 0) {
    return {
      action,
      success: false,
      error: `No traces found for agent ${action.targetAgent}`,
    };
  }

  const latest = deserializeTrace(agentTraces[0]);
  const dim = latest.hiddenState.length;

  // Apply perturbation: new_state = old_state + perturbation
  const perturbed = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    perturbed[i] = latest.hiddenState[i] + perturbation.vector[i];
  }

  // Write perturbed state as next round
  writeTrace({
    agentId: action.targetAgent!,
    layer: latest.layer,
    round: latest.round + 1,
    hiddenState: perturbed,
    convergenceDelta: null, // Will be computed on next real round
    metadata: {
      dim,
      timestamp: new Date().toISOString(),
      taskId,
      parentTraceId: agentTraces[0].id,
    },
  });

  logger.info(
    {
      taskId,
      targetAgent: action.targetAgent,
      sourceAgent: perturbation.sourceAgent,
      magnitude: perturbation.magnitude.toFixed(6),
      newRound: latest.round + 1,
    },
    'inject_feedback executed: perturbation applied',
  );

  return {
    action,
    success: true,
    perturbation,
  };
}

/**
 * Process all inject_feedback actions from a reflection result.
 * Returns results for each action.
 */
export function executeAllFeedbackActions(
  taskId: string,
  actions: ReflectionAction[],
): FeedbackExecutionResult[] {
  const feedbackActions = actions.filter((a) => a.type === 'inject_feedback');

  if (feedbackActions.length === 0) return [];

  // Compute correlation once for all actions
  const correlationResult = computeCorrelations(taskId);

  return feedbackActions.map((action) =>
    executeFeedbackAction(taskId, action, correlationResult),
  );
}
