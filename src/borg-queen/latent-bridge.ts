/**
 * Borg Queen Latent Bridge — Layer 6 RecursiveMAS Integration
 *
 * The Borg Queen is the collective's apex coordinator. In RecursiveMAS terms,
 * it is the "outer orchestrator" that initializes clusters, aggregates global
 * state, governs convergence, routes credit assignment, and directs capability
 * acquisition.
 *
 * 6 Modifications per Annika's L6 spec:
 *   Mod 1: RecursiveMAS Cluster Initializer
 *   Mod 2: Global Latent State Aggregator
 *   Mod 3: Per-Round Global Context Broadcast
 *   Mod 4: Credit Assignment Router
 *   Mod 5: MAS2 Integration Interface
 *   Mod 6: Capability Gap Broadcast
 */

import { LATENT_DIM } from '../hermes/types.js';
import type { LatentPayload, TraceEntry } from '../hermes/types.js';
import { ConvergenceTracker, cosineSimilarity } from '../hermes/transport.js';
import { writeTrace } from '../hermes/trace.js';
import { RECURSION_DEPTH_MAP } from '../ax/types.js';
import type { DepthOverride } from '../ax/types.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Agent participation definition in a cluster */
export interface ClusterParticipant {
  agentId: string;
  /**
   * Layer assignment. Standard layers: L1-L6.
   * Neo namespace: 'neo/<agent>' for cross-hemisphere engineering agents
   * dispatched via QM→Neo file-bus. Neo agents route to structural+reasoning
   * segments (code work + problem-solving).
   */
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | `neo/${string}`;
  /** Weight for global state aggregation (0-1, higher = more influence) */
  weight: number;
  /** Whether this agent produces latent states (vs text-only) */
  latentCapable: boolean;
}

/** Full cluster configuration */
export interface ClusterConfig {
  clusterId: string;
  taskId: string;
  participants: ClusterParticipant[];
  maxRounds: number;
  convergenceThreshold: number;
  /** Starting prior from L5 AxACE playbook (if available) */
  startingPrior?: Float32Array;
  /** Task complexity classification from L5 Self-Discover */
  complexity: 'linear' | 'moderate' | 'complex';
}

/** Per-round state from a single agent */
export interface AgentRoundState {
  agentId: string;
  layer: string;
  round: number;
  hiddenState: Float32Array;
  /** How much this agent's state changed from previous round */
  stateDelta: number | null;
  /** Agent's self-reported confidence */
  confidence: number;
}

/** Global state for a single round */
export interface GlobalRoundState {
  round: number;
  globalState: Float32Array;
  agentStates: AgentRoundState[];
  convergenceDelta: number | null;
  converged: boolean;
  /** Per-agent contribution scores for this round */
  contributions: Map<string, number>;
}

/** Complete cluster execution result */
export interface ClusterResult {
  clusterId: string;
  taskId: string;
  rounds: GlobalRoundState[];
  converged: boolean;
  finalGlobalState: Float32Array;
  totalRounds: number;
  /** Per-agent credit assignments across all rounds */
  creditAssignments: Map<string, CreditScore>;
}

/** Credit assignment for a single agent */
export interface CreditScore {
  agentId: string;
  /** Overall credit: positive = aligned with convergence, negative = divergent */
  totalCredit: number;
  /** Per-round credit breakdown */
  roundCredits: number[];
  /** How many rounds this agent's state moved toward final convergence */
  alignedRounds: number;
  /** How many rounds this agent's state moved away from final convergence */
  divergentRounds: number;
}

/** Capability gap signal for Borg Arc */
export interface CapabilityGap {
  /** Task type or domain where collective struggles */
  domain: string;
  /** Severity: higher = more urgent acquisition need */
  severity: number;
  /** Average convergence rounds for this domain (high = struggling) */
  avgConvergenceRounds: number;
  /** Percentage of tasks in this domain that needed human review */
  reviewRate: number;
  /** 768-dim gap signal for Borg Arc intent adjustment */
  gapVector: Float32Array;
}

/** MAS2 topology request */
export interface MAS2TopologyRequest {
  taskDescription: string;
  /** Why existing topologies don't fit */
  noveltyReason: string;
  /** Constraint: max agents in generated team */
  maxAgents: number;
  /** Available collective capabilities */
  availableLayers: string[];
}

/** MAS2 topology response (from Generator) */
export interface MAS2TopologyResponse {
  topology: ClusterParticipant[];
  /** Generator's confidence in this topology */
  confidence: number;
  /** Reasoning for agent selection */
  rationale: string;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Default convergence threshold (cosine similarity delta) */
export const DEFAULT_CONVERGENCE_THRESHOLD = 0.02;

/** Minimum rounds before convergence allowed */
const MIN_ROUNDS_BEFORE_CONVERGENCE = 2;

/** Playbook match threshold — below this, task is "novel" */
export const NOVELTY_THRESHOLD = 0.3;

/** Global state aggregation segment layout */
const GLOBAL_SEGMENTS = {
  structural: { start: 0, end: 128 },       // L1 GitNexus aggregate
  security: { start: 128, end: 256 },        // L2 DeepSec aggregate
  acquisition: { start: 256, end: 384 },     // L3 Borg Arc aggregate
  transport: { start: 384, end: 448 },       // L4 Hermes meta-signal
  reasoning: { start: 448, end: 576 },       // L5 Ax reasoning aggregate
  coordination: { start: 576, end: 704 },    // L6 Borg Queen self-signal
  gapAndCredit: { start: 704, end: 768 },    // Capability gaps + credit summary
} as const;

/** Layer to segment mapping for aggregation routing */
const LAYER_SEGMENT_MAP: Record<string, { start: number; end: number }> = {
  L1: GLOBAL_SEGMENTS.structural,
  L2: GLOBAL_SEGMENTS.security,
  L3: GLOBAL_SEGMENTS.acquisition,
  L4: GLOBAL_SEGMENTS.transport,
  L5: GLOBAL_SEGMENTS.reasoning,
  L6: GLOBAL_SEGMENTS.coordination,
};

/**
 * Neo namespace segment routing.
 * Cross-hemisphere engineering agents (neo/*) blend into structural + reasoning
 * segments since they perform code work (L1) and problem-solving (L5).
 * Split: 60% structural, 40% reasoning.
 */
const NEO_SEGMENT_BLEND = [
  { segment: GLOBAL_SEGMENTS.structural, weight: 0.6 },
  { segment: GLOBAL_SEGMENTS.reasoning, weight: 0.4 },
] as const;

/** Check if a layer string is a neo-namespaced agent */
function isNeoLayer(layer: string): boolean {
  return layer.startsWith('neo/');
}

// ── Mod 1: RecursiveMAS Cluster Initializer ────────────────────────────

/**
 * Initialize a RecursiveMAS cluster configuration for a task.
 * Sets participants, round budget, convergence criteria, and starting priors.
 */
export function initializeCluster(opts: {
  taskId: string;
  participants: Array<{ agentId: string; layer: string; latentCapable?: boolean }>;
  complexity: 'linear' | 'moderate' | 'complex';
  /** Optional prior from AxACE playbook */
  playbookPrior?: Float32Array;
  /** Override convergence threshold */
  convergenceThreshold?: number;
}): ClusterConfig {
  const { taskId, complexity, playbookPrior, convergenceThreshold } = opts;

  // Derive round budget from complexity
  const maxRounds = RECURSION_DEPTH_MAP[complexity];

  // Assign default weights: latent-capable agents get higher weight
  // Neo agents get slightly reduced weight (cross-hemisphere latency cost)
  const participants: ClusterParticipant[] = opts.participants.map((p) => ({
    agentId: p.agentId,
    layer: p.layer as ClusterParticipant['layer'],
    weight: p.latentCapable !== false
      ? (isNeoLayer(p.layer) ? 0.8 : 1.0)
      : 0.5,
    latentCapable: p.latentCapable !== false,
  }));

  // Normalize weights
  const totalWeight = participants.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight > 0) {
    for (const p of participants) {
      p.weight /= totalWeight;
    }
  }

  return {
    clusterId: `cluster-${taskId}-${Date.now()}`,
    taskId,
    participants,
    maxRounds,
    convergenceThreshold: convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD,
    startingPrior: playbookPrior ? new Float32Array(playbookPrior) : undefined,
    complexity,
  };
}

/**
 * Create the initialization signal for all cluster participants.
 * Each agent receives the starting prior (if any) plus cluster metadata
 * encoded into their layer-specific segment.
 */
export function createClusterInitSignal(
  config: ClusterConfig,
): Float32Array {
  const vec = new Float32Array(LATENT_DIM);

  // Start from playbook prior if available
  if (config.startingPrior) {
    for (let i = 0; i < Math.min(config.startingPrior.length, LATENT_DIM); i++) {
      vec[i] = config.startingPrior[i] * 0.5; // Damped blend
    }
  }

  // Encode cluster metadata into coordination segment
  const coordSeg = GLOBAL_SEGMENTS.coordination;
  const participantCount = config.participants.length;
  const roundBudget = config.maxRounds;

  for (let i = coordSeg.start; i < coordSeg.end; i++) {
    const pos = (i - coordSeg.start) / (coordSeg.end - coordSeg.start);
    vec[i] = Math.sin(pos * Math.PI * participantCount) *
      (roundBudget / 10) * // Scale by normalized round budget
      (config.complexity === 'complex' ? 1.0 : config.complexity === 'moderate' ? 0.7 : 0.4);
  }

  normalizeVector(vec);
  return vec;
}

// ── Mod 2: Global Latent State Aggregator ──────────────────────────────

/**
 * Aggregate multiple agent hidden states into a single global state vector.
 * Uses weighted mean with layer-specific segment routing.
 */
export function aggregateGlobalState(
  agentStates: AgentRoundState[],
  participants: ClusterParticipant[],
  previousGlobal?: Float32Array,
): Float32Array {
  const globalState = new Float32Array(LATENT_DIM);

  // Build weight lookup
  const weightMap = new Map<string, number>();
  for (const p of participants) {
    weightMap.set(p.agentId, p.weight);
  }

  // Route each agent's state to its layer-specific segment
  for (const agentState of agentStates) {
    const weight = weightMap.get(agentState.agentId) ?? 0.5;
    const segment = LAYER_SEGMENT_MAP[agentState.layer];

    if (segment) {
      // Route to layer-specific segment (standard L1-L6)
      const segLen = segment.end - segment.start;
      for (let i = 0; i < segLen && i < agentState.hiddenState.length; i++) {
        globalState[segment.start + i] += agentState.hiddenState[i] * weight;
      }
    } else if (isNeoLayer(agentState.layer)) {
      // Neo namespace: blend into structural + reasoning segments
      for (const blend of NEO_SEGMENT_BLEND) {
        const segLen = blend.segment.end - blend.segment.start;
        for (let i = 0; i < segLen && i < agentState.hiddenState.length; i++) {
          globalState[blend.segment.start + i] +=
            agentState.hiddenState[i] * weight * blend.weight;
        }
      }
    } else {
      // Unknown layer: distribute across full vector with reduced weight
      for (let i = 0; i < LATENT_DIM && i < agentState.hiddenState.length; i++) {
        globalState[i] += agentState.hiddenState[i] * weight * 0.1;
      }
    }
  }

  // Blend with previous global state for stability (momentum)
  if (previousGlobal) {
    const momentum = 0.3;
    for (let i = 0; i < LATENT_DIM; i++) {
      globalState[i] = globalState[i] * (1 - momentum) + previousGlobal[i] * momentum;
    }
  }

  normalizeVector(globalState);
  return globalState;
}

/**
 * Check global convergence by comparing current global state to previous.
 */
export function checkGlobalConvergence(
  current: Float32Array,
  previous: Float32Array | null,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): { converged: boolean; delta: number | null } {
  if (!previous) {
    return { converged: false, delta: null };
  }
  const sim = cosineSimilarity(previous, current);
  const delta = 1 - sim;
  return {
    converged: delta < threshold,
    delta,
  };
}

// ── Mod 3: Per-Round Global Context Broadcast ──────────────────────────

/**
 * Create per-agent broadcast payloads from the global state.
 * Each agent gets the global state plus their contribution weight signal.
 */
export function createGlobalBroadcast(
  globalState: Float32Array,
  participants: ClusterParticipant[],
  roundsRemaining: number,
  contributions?: Map<string, number>,
): Map<string, LatentPayload> {
  const broadcasts = new Map<string, LatentPayload>();

  for (const participant of participants) {
    if (!participant.latentCapable) continue;

    // Start from global state
    const agentSignal = new Float32Array(globalState);

    // Encode contribution weight in the gap/credit segment (last 64 dims)
    const creditSeg = GLOBAL_SEGMENTS.gapAndCredit;
    const contribution = contributions?.get(participant.agentId) ?? participant.weight;
    const roundsNorm = Math.min(roundsRemaining / 10, 1.0);

    for (let i = creditSeg.start; i < creditSeg.end; i++) {
      const pos = (i - creditSeg.start) / (creditSeg.end - creditSeg.start);
      agentSignal[i] = contribution * Math.sin(pos * Math.PI) +
        roundsNorm * Math.cos(pos * Math.PI * 2);
    }

    normalizeVector(agentSignal);

    broadcasts.set(participant.agentId, {
      data: agentSignal,
      numVectors: 1,
      dim: LATENT_DIM,
      adapterKey: `borgqueen_L6_to_${participant.agentId}`,
      sourceHiddenSize: LATENT_DIM,
    });
  }

  return broadcasts;
}

// ── Mod 4: Credit Assignment Router ────────────────────────────────────

/**
 * Compute per-agent contribution score for a single round.
 * Measures correlation between agent's state delta and the global state direction.
 */
export function computeRoundContribution(
  agentState: AgentRoundState,
  currentGlobal: Float32Array,
  previousGlobal?: Float32Array,
): number {
  if (!previousGlobal) {
    // First round: no delta to compare, assign neutral contribution
    return 0.5;
  }

  // Agent's correlation with global state direction
  const globalDelta = new Float32Array(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    globalDelta[i] = currentGlobal[i] - previousGlobal[i];
  }

  // Correlation between agent state and global direction
  const sim = cosineSimilarity(agentState.hiddenState, globalDelta);

  // Normalize to 0-1 range (cosine sim is -1 to 1)
  return (sim + 1) / 2;
}

/**
 * Compute full credit assignments across all rounds of a completed cluster.
 */
export function computeCreditAssignments(
  rounds: GlobalRoundState[],
  finalGlobal: Float32Array,
): Map<string, CreditScore> {
  const credits = new Map<string, CreditScore>();

  // Initialize credit scores for all agents seen
  for (const round of rounds) {
    for (const agentState of round.agentStates) {
      if (!credits.has(agentState.agentId)) {
        credits.set(agentState.agentId, {
          agentId: agentState.agentId,
          totalCredit: 0,
          roundCredits: [],
          alignedRounds: 0,
          divergentRounds: 0,
        });
      }
    }
  }

  // Compute per-round credits
  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r];

    for (const agentState of round.agentStates) {
      const credit = credits.get(agentState.agentId)!;

      // Compare agent state to final global state
      const alignment = cosineSimilarity(agentState.hiddenState, finalGlobal);

      // Credit = alignment with final converged state, weighted by round (later rounds matter more)
      const roundWeight = (r + 1) / rounds.length;
      const roundCredit = alignment * roundWeight;

      credit.roundCredits.push(roundCredit);
      credit.totalCredit += roundCredit;

      if (alignment > 0) {
        credit.alignedRounds++;
      } else {
        credit.divergentRounds++;
      }
    }
  }

  return credits;
}

// ── Mod 5: MAS2 Integration Interface ──────────────────────────────────

/**
 * Check if a task is novel (no good playbook match) and needs MAS2 topology generation.
 */
export function detectTaskNovelty(
  taskDescription: string,
  playbookMatchScore: number,
): { isNovel: boolean; confidence: number } {
  return {
    isNovel: playbookMatchScore < NOVELTY_THRESHOLD,
    confidence: 1 - playbookMatchScore, // Higher confidence in novelty when lower match
  };
}

/**
 * Create a MAS2 topology request from a novel task.
 */
export function createMAS2Request(
  taskDescription: string,
  noveltyReason: string,
  availableLayers: string[] = ['L1', 'L2', 'L3', 'L4', 'L5'],
): MAS2TopologyRequest {
  return {
    taskDescription,
    noveltyReason,
    maxAgents: 5, // Default cap
    availableLayers,
  };
}

/**
 * Validate a MAS2-generated topology against available collective capabilities.
 */
export function validateMAS2Topology(
  topology: MAS2TopologyResponse,
  availableAgents: string[],
): { valid: boolean; missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const participant of topology.topology) {
    if (!availableAgents.includes(participant.agentId)) {
      missing.push(participant.agentId);
    }
  }

  if (topology.confidence < 0.5) {
    warnings.push(`MAS2 confidence low (${topology.confidence.toFixed(2)})`);
  }

  if (topology.topology.length > 6) {
    warnings.push(`Topology has ${topology.topology.length} agents (recommend <= 6)`);
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}

/**
 * Convert a MAS2 topology into a ClusterConfig.
 */
export function mas2ToClusterConfig(
  taskId: string,
  topology: MAS2TopologyResponse,
  complexity: 'linear' | 'moderate' | 'complex',
): ClusterConfig {
  return initializeCluster({
    taskId,
    participants: topology.topology.map((p) => ({
      agentId: p.agentId,
      layer: p.layer,
      latentCapable: p.latentCapable,
    })),
    complexity,
  });
}

// ── Mod 6: Capability Gap Broadcast ────────────────────────────────────

/**
 * Analyze completed cluster results to detect capability gaps.
 * Identifies domains where the collective struggles (high rounds, low convergence).
 */
export function detectCapabilityGaps(
  completedClusters: Array<{
    taskId: string;
    domain: string;
    result: ClusterResult;
  }>,
): CapabilityGap[] {
  // Group by domain
  const domainStats = new Map<string, {
    totalRounds: number;
    clusterCount: number;
    reviewCount: number;
    convergedCount: number;
    avgStates: Float32Array[];
  }>();

  for (const cluster of completedClusters) {
    let stats = domainStats.get(cluster.domain);
    if (!stats) {
      stats = {
        totalRounds: 0,
        clusterCount: 0,
        reviewCount: 0,
        convergedCount: 0,
        avgStates: [],
      };
      domainStats.set(cluster.domain, stats);
    }

    stats.totalRounds += cluster.result.totalRounds;
    stats.clusterCount++;
    if (cluster.result.converged) stats.convergedCount++;
    // If many rounds needed, likely struggled
    if (cluster.result.totalRounds >= RECURSION_DEPTH_MAP.complex) {
      stats.reviewCount++;
    }
    stats.avgStates.push(cluster.result.finalGlobalState);
  }

  const gaps: CapabilityGap[] = [];

  for (const [domain, stats] of Array.from(domainStats.entries())) {
    const avgRounds = stats.totalRounds / stats.clusterCount;
    const reviewRate = stats.reviewCount / stats.clusterCount;
    const convergenceRate = stats.convergedCount / stats.clusterCount;

    // Flag as gap if high average rounds or low convergence rate
    const severity = (avgRounds / RECURSION_DEPTH_MAP.complex) * 0.5 +
      (1 - convergenceRate) * 0.3 +
      reviewRate * 0.2;

    if (severity > 0.3) {
      // Build gap vector encoding the domain's struggle pattern
      const gapVector = new Float32Array(LATENT_DIM);
      // Average all final states from this domain's clusters
      for (const state of stats.avgStates) {
        for (let i = 0; i < LATENT_DIM && i < state.length; i++) {
          gapVector[i] += state[i] / stats.avgStates.length;
        }
      }
      // Invert: the gap is what's missing (negative of what was produced)
      for (let i = 0; i < LATENT_DIM; i++) {
        gapVector[i] = -gapVector[i];
      }
      normalizeVector(gapVector);

      gaps.push({
        domain,
        severity,
        avgConvergenceRounds: avgRounds,
        reviewRate,
        gapVector,
      });
    }
  }

  // Sort by severity descending
  gaps.sort((a, b) => b.severity - a.severity);
  return gaps;
}

/**
 * Convert capability gaps into Borg Arc context signal.
 * This feeds into Borg Arc's intent vector to prioritize acquisitions.
 */
export function gapsToBorgArcContext(
  gaps: CapabilityGap[],
): { gapSignal: Float32Array; layerPriorities: Record<string, number> } {
  const gapSignal = new Float32Array(LATENT_DIM);
  const layerPriorities: Record<string, number> = {};

  // Blend all gap vectors weighted by severity
  for (const gap of gaps) {
    for (let i = 0; i < LATENT_DIM; i++) {
      gapSignal[i] += gap.gapVector[i] * gap.severity;
    }
  }
  normalizeVector(gapSignal);

  // Derive layer priorities from gap segment analysis
  for (const [layer, segment] of Object.entries(LAYER_SEGMENT_MAP)) {
    let energy = 0;
    for (let i = segment.start; i < segment.end; i++) {
      energy += gapSignal[i] * gapSignal[i];
    }
    layerPriorities[layer] = Math.sqrt(energy / (segment.end - segment.start));
  }

  // Neo composite priority: weighted blend of structural + reasoning energy
  let neoEnergy = 0;
  for (const blend of NEO_SEGMENT_BLEND) {
    let segEnergy = 0;
    for (let i = blend.segment.start; i < blend.segment.end; i++) {
      segEnergy += gapSignal[i] * gapSignal[i];
    }
    neoEnergy += Math.sqrt(segEnergy / (blend.segment.end - blend.segment.start)) * blend.weight;
  }
  layerPriorities['neo'] = neoEnergy;

  return { gapSignal, layerPriorities };
}

// ── Full Cluster Execution ─────────────────────────────────────────────

/**
 * Run a full RecursiveMAS cluster as the outer orchestrator.
 * This is the Borg Queen's main coordination loop.
 */
export function runCluster(
  config: ClusterConfig,
  /** Pre-computed agent states per round. In production these come via Outer Link. */
  agentStatesPerRound: AgentRoundState[][],
): ClusterResult {
  const rounds: GlobalRoundState[] = [];
  let previousGlobal: Float32Array | null = config.startingPrior
    ? new Float32Array(config.startingPrior) : null;
  let converged = false;

  const effectiveRounds = Math.min(config.maxRounds, agentStatesPerRound.length);

  for (let round = 0; round < effectiveRounds; round++) {
    const agentStates = agentStatesPerRound[round];

    // Aggregate global state
    const globalState = aggregateGlobalState(
      agentStates, config.participants, previousGlobal ?? undefined,
    );

    // Check convergence
    const conv = checkGlobalConvergence(
      globalState, previousGlobal, config.convergenceThreshold,
    );

    // Compute per-agent contributions
    const contributions = new Map<string, number>();
    for (const agentState of agentStates) {
      const contribution = computeRoundContribution(
        agentState, globalState, previousGlobal ?? undefined,
      );
      contributions.set(agentState.agentId, contribution);
    }

    // Write trace
    writeTrace({
      agentId: 'borg-queen',
      layer: 'L6',
      round,
      hiddenState: globalState,
      convergenceDelta: conv.delta,
      metadata: {
        dim: LATENT_DIM,
        timestamp: new Date().toISOString(),
        taskId: config.taskId,
      },
    });

    rounds.push({
      round,
      globalState: new Float32Array(globalState),
      agentStates,
      convergenceDelta: conv.delta,
      converged: conv.converged,
      contributions,
    });

    previousGlobal = new Float32Array(globalState);

    // Check for early convergence (but not before minimum rounds)
    if (conv.converged && round >= MIN_ROUNDS_BEFORE_CONVERGENCE - 1) {
      converged = true;
      break;
    }
  }

  const finalGlobal = previousGlobal ?? new Float32Array(LATENT_DIM);

  // Compute credit assignments
  const creditAssignments = computeCreditAssignments(rounds, finalGlobal);

  return {
    clusterId: config.clusterId,
    taskId: config.taskId,
    rounds,
    converged,
    finalGlobalState: finalGlobal,
    totalRounds: rounds.length,
    creditAssignments,
  };
}

/**
 * Create a Borg Queen LatentPayload for downstream dispatch.
 */
export function createBorgQueenPayload(hiddenState: Float32Array): LatentPayload {
  return {
    data: new Float32Array(hiddenState),
    numVectors: 1,
    dim: LATENT_DIM,
    adapterKey: 'borgqueen_L6_global',
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
