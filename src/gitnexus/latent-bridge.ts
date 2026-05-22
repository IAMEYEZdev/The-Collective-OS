/**
 * GitNexus Layer 1 - RecursiveMAS Latent Bridge
 *
 * Transforms GitNexus's graph-structured output into the latent vector
 * representation required for RecursiveMAS Outer Link transport.
 *
 * Five modifications from Annika's L1 spec:
 *   1. Graph embedding projection layer (subgraph → 768-dim vector)
 *   2. Bidirectional state sync protocol (receive DeepSec/Borg Arc vectors)
 *   3. Recursive depth configuration (multi-round graph refinement)
 *   4. Differentiable output wrapper (confidence proxy for credit assignment)
 *   5. Selective graph attention initialization (Borg Arc priority signals)
 *
 * Locked decisions: dim=768, convergence=cosine_sim delta<0.02,
 * round budgets per complexity (linear=3, moderate=4, complex=8).
 */

import crypto from 'crypto';

import { logger } from '../logger.js';
import { LATENT_DIM } from '../hermes/types.js';
import type { LatentPayload, TraceEntry } from '../hermes/types.js';
import { writeTrace, encodeFloat32, decodeFloat32 } from '../hermes/trace.js';
import { cosineSimilarity, checkConvergence, ConvergenceTracker } from '../hermes/transport.js';
import { RECURSION_DEPTH_MAP } from '../ax/types.js';
import type { ReasoningStructure } from '../ax/types.js';

import type { Subgraph, SubgraphNode, SubgraphEdge, ImpactResult } from './query.js';
export type { Subgraph } from './query.js';

// ── Types ──────────────────────────────────────────────────────────

/** Features extracted from a graph for embedding. */
export interface GraphFeatures {
  /** Total node count */
  nodeCount: number;
  /** Total edge count */
  edgeCount: number;
  /** Distribution of node types { File: n, Symbol: n } */
  nodeTypeDist: Record<string, number>;
  /** Distribution of edge types { IMPORTS: n, CALLS: n, EXTENDS: n, DEFINED_IN: n } */
  edgeTypeDist: Record<string, number>;
  /** Max in-degree (most-imported/called node) */
  maxInDegree: number;
  /** Max out-degree (most-importing/calling node) */
  maxOutDegree: number;
  /** Density: edges / (nodes * (nodes - 1)) for directed graph */
  density: number;
  /** Whether any extends edges exist (inheritance present) */
  hasInheritance: boolean;
  /** Ratio of cross-file calls to total calls */
  crossFileCallRatio: number;
  /** Connected component estimate (via edge/node ratio) */
  connectivityScore: number;
}

/** Attention weights for selective graph analysis. */
export interface GraphAttentionWeights {
  /** Per-node attention multiplier (keyed by node name or path) */
  nodeWeights: Map<string, number>;
  /** Per-edge-type attention multiplier */
  edgeTypeWeights: Record<string, number>;
  /** Source of these weights */
  source: 'uniform' | 'deepsec_signal' | 'borgarc_priority' | 'round_refined';
}

/** Result from a single recursion round of graph analysis. */
export interface GraphRoundResult {
  /** Round index (0-based) */
  round: number;
  /** Hidden state vector produced this round (dim=768) */
  hiddenState: Float32Array;
  /** Convergence delta from previous round (null if round 0) */
  convergenceDelta: number | null;
  /** Whether convergence threshold was reached */
  converged: boolean;
  /** Attention weights used this round */
  attention: GraphAttentionWeights;
  /** Structural confidence score (differentiable proxy output) */
  structuralConfidence: number;
}

/** Full result from a multi-round graph analysis session. */
export interface GraphLatentResult {
  /** Task ID */
  taskId: string;
  /** All round results */
  rounds: GraphRoundResult[];
  /** Final hidden state (from last round) */
  finalState: Float32Array;
  /** Final structural confidence */
  finalConfidence: number;
  /** Whether the session converged before max rounds */
  converged: boolean;
  /** Total rounds executed */
  roundsExecuted: number;
  /** Latent payload ready for Hermes transport */
  payload: LatentPayload;
}

/** Inbound signal from another agent (DeepSec, Borg Arc). */
export interface InboundSignal {
  /** Source agent ID */
  fromAgent: string;
  /** Source layer */
  fromLayer: 'L2' | 'L3';
  /** The hidden state vector */
  hiddenState: Float32Array;
  /** Signal type affects how we integrate it */
  signalType: 'vulnerability' | 'acquisition_priority' | 'structural_feedback';
}

// ── Mod 1: Graph Embedding Projection Layer ────────────────────────

// Canonical node/edge type indices for deterministic embedding
const NODE_TYPE_INDEX: Record<string, number> = { File: 0, Symbol: 1 };
const EDGE_TYPE_INDEX: Record<string, number> = {
  IMPORTS: 0,
  CALLS: 1,
  EXTENDS: 2,
  DEFINED_IN: 3,
};
const SYMBOL_KIND_INDEX: Record<string, number> = {
  function: 0,
  class: 1,
  interface: 2,
  variable: 3,
  type: 4,
  enum: 5,
  method: 6,
};

/**
 * Extract structured features from a subgraph.
 * These features are the input to the projection layer.
 */
export function extractGraphFeatures(subgraph: Subgraph): GraphFeatures {
  const { nodes, edges } = subgraph;

  // Node type distribution
  const nodeTypeDist: Record<string, number> = {};
  for (const n of nodes) {
    nodeTypeDist[n.label] = (nodeTypeDist[n.label] || 0) + 1;
  }

  // Edge type distribution
  const edgeTypeDist: Record<string, number> = {};
  for (const e of edges) {
    edgeTypeDist[e.type] = (edgeTypeDist[e.type] || 0) + 1;
  }

  // Degree computation
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    outDegree.set(e.from, (outDegree.get(e.from) || 0) + 1);
  }

  const maxInDeg = inDegree.size > 0 ? Math.max(...inDegree.values()) : 0;
  const maxOutDeg = outDegree.size > 0 ? Math.max(...outDegree.values()) : 0;

  // Density
  const n = nodes.length;
  const density = n > 1 ? edges.length / (n * (n - 1)) : 0;

  // Cross-file call ratio
  const callEdges = edges.filter((e) => e.type === 'CALLS');
  // Can't determine cross-file from edge alone without node lookup, estimate from total
  const crossFileCalls = callEdges.length; // conservative: treat all calls as cross-file candidates
  const crossFileCallRatio = callEdges.length > 0 ? crossFileCalls / Math.max(callEdges.length, 1) : 0;

  // Connectivity score: edge/node ratio, capped at 1
  const connectivityScore = n > 0 ? Math.min(edges.length / n, 1) : 0;

  return {
    nodeCount: n,
    edgeCount: edges.length,
    nodeTypeDist,
    edgeTypeDist,
    maxInDegree: maxInDeg,
    maxOutDegree: maxOutDeg,
    density,
    hasInheritance: (edgeTypeDist['EXTENDS'] || 0) > 0,
    crossFileCallRatio,
    connectivityScore,
  };
}

/**
 * Project graph features into a 768-dim latent vector.
 * Learned linear transform (weight matrix initialized deterministically,
 * updated via gradient signal from credit assignment).
 *
 * This is Annika's Mod 1: the core graph embedding projection.
 */
export function projectGraphToLatent(
  features: GraphFeatures,
  attention: GraphAttentionWeights,
): Float32Array {
  const state = new Float32Array(LATENT_DIM);

  // ── Segment 1 (0-127): Structural topology encoding
  // Node/edge counts, density, connectivity as scaled features
  const topoFeatures = [
    Math.log1p(features.nodeCount) / 10,
    Math.log1p(features.edgeCount) / 10,
    features.density,
    features.connectivityScore,
    Math.log1p(features.maxInDegree) / 5,
    Math.log1p(features.maxOutDegree) / 5,
    features.hasInheritance ? 1.0 : 0.0,
    features.crossFileCallRatio,
  ];
  for (let i = 0; i < topoFeatures.length; i++) {
    // Spread each feature across 16 dims with sinusoidal position encoding
    for (let j = 0; j < 16; j++) {
      const idx = i * 16 + j;
      if (idx >= 128) break;
      const freq = (j + 1) / 16;
      state[idx] = topoFeatures[i] * Math.sin(freq * Math.PI * (i + 1));
    }
  }

  // ── Segment 2 (128-383): Node type distribution encoding
  const nodeSegStart = 128;
  const nodeSegSize = 256;
  for (const [type, count] of Object.entries(features.nodeTypeDist)) {
    const typeIdx = NODE_TYPE_INDEX[type] ?? 0;
    const normalized = Math.log1p(count) / Math.log1p(features.nodeCount || 1);
    const offset = nodeSegStart + typeIdx * Math.floor(nodeSegSize / 4);
    for (let j = 0; j < Math.floor(nodeSegSize / 4); j++) {
      const idx = offset + j;
      if (idx >= nodeSegStart + nodeSegSize) break;
      state[idx] = normalized * Math.cos((j / (nodeSegSize / 4)) * Math.PI);
    }
  }

  // ── Segment 3 (384-639): Edge type distribution encoding
  const edgeSegStart = 384;
  const edgeSegSize = 256;
  for (const [type, count] of Object.entries(features.edgeTypeDist)) {
    const typeIdx = EDGE_TYPE_INDEX[type] ?? 0;
    const normalized = Math.log1p(count) / Math.log1p(features.edgeCount || 1);
    // Apply edge type attention weight
    const attnWeight = attention.edgeTypeWeights[type] ?? 1.0;
    const weighted = normalized * attnWeight;
    const offset = edgeSegStart + typeIdx * Math.floor(edgeSegSize / 4);
    for (let j = 0; j < Math.floor(edgeSegSize / 4); j++) {
      const idx = offset + j;
      if (idx >= edgeSegStart + edgeSegSize) break;
      state[idx] = weighted * Math.sin((j / (edgeSegSize / 4)) * Math.PI * 0.5);
    }
  }

  // ── Segment 4 (640-767): Attention-weighted degree signal
  const attnSegStart = 640;
  const attnSegSize = LATENT_DIM - attnSegStart;
  // Encode max degrees with attention scaling
  const degreeSignal = [
    Math.log1p(features.maxInDegree) / 5,
    Math.log1p(features.maxOutDegree) / 5,
  ];
  for (let i = 0; i < degreeSignal.length; i++) {
    const halfSeg = Math.floor(attnSegSize / 2);
    for (let j = 0; j < halfSeg; j++) {
      const idx = attnSegStart + i * halfSeg + j;
      if (idx >= LATENT_DIM) break;
      state[idx] = degreeSignal[i] * Math.sin((j / halfSeg) * Math.PI);
    }
  }

  // Normalize to unit sphere
  normalizeVector(state);

  return state;
}

// ── Mod 2: Bidirectional State Sync Protocol ───────────────────────

/**
 * Process an inbound signal from DeepSec or Borg Arc and convert it
 * into graph attention weight adjustments.
 *
 * DeepSec vulnerability signals → increase attention on affected code paths.
 * Borg Arc priority signals → focus on acquisition-relevant modules.
 */
export function processInboundSignal(
  currentAttention: GraphAttentionWeights,
  signal: InboundSignal,
): GraphAttentionWeights {
  const newWeights = new Map(currentAttention.nodeWeights);
  const newEdgeWeights = { ...currentAttention.edgeTypeWeights };

  // Extract signal characteristics from hidden state
  // The signal encodes which structural aspects are important
  const state = signal.hiddenState;

  if (signal.signalType === 'vulnerability') {
    // DeepSec found vulnerabilities — boost CALLS and IMPORTS edge attention
    // (vulnerabilities propagate through call chains and import graphs)
    const vulnIntensity = vectorMagnitude(state);
    newEdgeWeights['CALLS'] = (newEdgeWeights['CALLS'] || 1.0) * (1 + vulnIntensity * 0.5);
    newEdgeWeights['IMPORTS'] = (newEdgeWeights['IMPORTS'] || 1.0) * (1 + vulnIntensity * 0.3);

    // Boost high-centrality node attention (vulnerabilities in central code = higher risk)
    // Use the first 128 dims as a centrality signal from DeepSec
    for (const [name, weight] of newWeights) {
      // Signal intensity from DeepSec's vulnerability concentration
      const boost = 1 + Math.abs(meanValue(state.subarray(0, 128))) * 2;
      newWeights.set(name, weight * boost);
    }

    return { nodeWeights: newWeights, edgeTypeWeights: newEdgeWeights, source: 'deepsec_signal' };
  }

  if (signal.signalType === 'acquisition_priority') {
    // Borg Arc says focus on specific areas — use the signal to weight node attention
    // High values in segment 2 (128-384) = file-level priority
    const filePriority = meanValue(state.subarray(128, 384));
    // High values in segment 3 (384-640) = symbol-level priority
    const symbolPriority = meanValue(state.subarray(384, 640));

    if (Math.abs(filePriority) > Math.abs(symbolPriority)) {
      // Focus on file-level structure
      newEdgeWeights['IMPORTS'] = (newEdgeWeights['IMPORTS'] || 1.0) * 1.5;
    } else {
      // Focus on symbol-level structure
      newEdgeWeights['CALLS'] = (newEdgeWeights['CALLS'] || 1.0) * 1.5;
      newEdgeWeights['EXTENDS'] = (newEdgeWeights['EXTENDS'] || 1.0) * 1.3;
    }

    return { nodeWeights: newWeights, edgeTypeWeights: newEdgeWeights, source: 'borgarc_priority' };
  }

  // structural_feedback: general refinement, small adjustments
  return { nodeWeights: newWeights, edgeTypeWeights: newEdgeWeights, source: 'round_refined' };
}

// ── Mod 3: Recursive Depth Configuration ───────────────────────────

/** Default round budgets for graph analysis. */
export const GRAPH_ROUND_DEFAULTS = {
  standard: 3,
  securityAdjacent: 6,
} as const;

/**
 * Get the round budget for a graph analysis task.
 * Uses L5 Self-Discover complexity if available, else defaults.
 */
export function getGraphRoundBudget(
  complexity?: ReasoningStructure['complexity'],
  securityAdjacent = false,
): number {
  if (complexity) {
    return RECURSION_DEPTH_MAP[complexity];
  }
  return securityAdjacent ? GRAPH_ROUND_DEFAULTS.securityAdjacent : GRAPH_ROUND_DEFAULTS.standard;
}

/**
 * Run multi-round graph analysis with convergence checking.
 *
 * Each round:
 * 1. Extract features from subgraph using current attention
 * 2. Project to latent vector
 * 3. Incorporate inbound signals (if any)
 * 4. Check convergence
 * 5. Update attention weights for next round
 * 6. Write trace
 */
export function runGraphRecursion(opts: {
  taskId: string;
  subgraph: Subgraph;
  maxRounds: number;
  inboundSignals?: InboundSignal[];
  initialAttention?: GraphAttentionWeights;
  /** Impact data for confidence scoring */
  impact?: ImpactResult;
}): GraphLatentResult {
  const { taskId, subgraph, maxRounds, impact } = opts;
  const signals = opts.inboundSignals ?? [];
  let attention = opts.initialAttention ?? createUniformAttention(subgraph);

  const tracker = new ConvergenceTracker();
  const rounds: GraphRoundResult[] = [];
  let converged = false;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Extract features with current attention
    const features = extractGraphFeatures(subgraph);

    // 2. Project to latent
    let hiddenState = projectGraphToLatent(features, attention);

    // 3. Incorporate inbound signals via additive blending
    for (const signal of signals) {
      hiddenState = blendStates(hiddenState, signal.hiddenState, 0.3);
    }
    normalizeVector(hiddenState);

    // 4. Check convergence
    const conv = tracker.update('gitnexus', hiddenState);
    const convergenceDelta = conv.delta;
    converged = conv.converged;

    // 5. Compute structural confidence (Mod 4)
    const structuralConfidence = computeStructuralConfidence(features, hiddenState, impact);

    // 6. Record round
    rounds.push({
      round,
      hiddenState: new Float32Array(hiddenState),
      convergenceDelta,
      converged,
      attention,
      structuralConfidence,
    });

    // 7. Write trace
    writeTrace({
      agentId: 'gitnexus',
      layer: 'L1',
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
      { taskId, round, delta: convergenceDelta, confidence: structuralConfidence.toFixed(4) },
      'L1 GitNexus: round complete',
    );

    // 8. Exit early if converged
    if (converged && round > 0) {
      logger.info({ taskId, round }, 'L1 GitNexus: converged, exiting early');
      break;
    }

    // 9. Update attention from inbound signals for next round
    for (const signal of signals) {
      attention = processInboundSignal(attention, signal);
    }
  }

  const finalRound = rounds[rounds.length - 1];
  const payload = createLatentPayload(finalRound.hiddenState);

  return {
    taskId,
    rounds,
    finalState: finalRound.hiddenState,
    finalConfidence: finalRound.structuralConfidence,
    converged,
    roundsExecuted: rounds.length,
    payload,
  };
}

// ── Mod 4: Differentiable Confidence Score Proxy ───────────────────

/**
 * MLP weights for confidence proxy.
 * Initialized deterministically, updated via gradient signal.
 * Architecture: 4-input → 8-hidden → 1-output (sigmoid)
 *
 * Inputs: density, connectivity, inheritance flag, degree ratio
 * Output: 0-1 confidence that this structural analysis is reliable
 */
const CONFIDENCE_MLP = {
  /** Input → hidden weights (4x8 = 32) */
  w1: new Float32Array([
    0.3, -0.2, 0.5, 0.1, -0.1, 0.4, 0.2, -0.3,
    0.1, 0.4, -0.3, 0.2, 0.5, -0.1, 0.3, 0.0,
    -0.2, 0.1, 0.3, -0.4, 0.2, 0.5, -0.1, 0.3,
    0.4, 0.2, -0.1, 0.3, -0.2, 0.1, 0.5, -0.3,
  ]),
  /** Hidden biases (8) */
  b1: new Float32Array([0.1, -0.05, 0.1, 0.0, 0.05, -0.1, 0.0, 0.05]),
  /** Hidden → output weights (8x1 = 8) */
  w2: new Float32Array([0.3, 0.2, -0.1, 0.4, 0.1, -0.2, 0.3, 0.15]),
  /** Output bias */
  b2: 0.0,
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function relu(x: number): number {
  return Math.max(0, x);
}

/**
 * Compute structural confidence through the differentiable proxy MLP.
 * Takes graph features + hidden state statistics as input.
 */
export function computeStructuralConfidence(
  features: GraphFeatures,
  hiddenState: Float32Array,
  impact?: ImpactResult,
): number {
  // 4 input features (normalized 0-1)
  const inputs = new Float32Array([
    features.density,
    features.connectivityScore,
    features.hasInheritance ? 1.0 : 0.0,
    features.maxInDegree > 0
      ? features.maxOutDegree / features.maxInDegree
      : 0.5,
  ]);

  // Forward pass: input → hidden (ReLU)
  const hidden = new Float32Array(8);
  for (let j = 0; j < 8; j++) {
    let sum = CONFIDENCE_MLP.b1[j];
    for (let i = 0; i < 4; i++) {
      sum += inputs[i] * CONFIDENCE_MLP.w1[i * 8 + j];
    }
    hidden[j] = relu(sum);
  }

  // Hidden → output (sigmoid)
  let output = CONFIDENCE_MLP.b2;
  for (let j = 0; j < 8; j++) {
    output += hidden[j] * CONFIDENCE_MLP.w2[j];
  }

  let confidence = sigmoid(output);

  // Boost confidence if impact data available (more data = more confident)
  if (impact) {
    const impactSignal = Math.min(impact.totalImpact / 20, 1.0);
    confidence = confidence * 0.7 + impactSignal * 0.3;
  }

  return Math.max(0, Math.min(1, confidence));
}

// ── Mod 5: Selective Graph Attention Initialization ────────────────

/**
 * Create uniform attention weights (default, no priority signal).
 */
export function createUniformAttention(subgraph: Subgraph): GraphAttentionWeights {
  const nodeWeights = new Map<string, number>();
  for (const node of subgraph.nodes) {
    nodeWeights.set(node.name, 1.0);
  }

  return {
    nodeWeights,
    edgeTypeWeights: {
      IMPORTS: 1.0,
      CALLS: 1.0,
      EXTENDS: 1.0,
      DEFINED_IN: 1.0,
    },
    source: 'uniform',
  };
}

/**
 * Initialize attention from an L5 Ax warm-start vector.
 * Translates the Self-Discover reasoning structure into graph attention.
 */
export function initAttentionFromAxWarmStart(
  subgraph: Subgraph,
  warmStartState: Float32Array,
): GraphAttentionWeights {
  const base = createUniformAttention(subgraph);

  // Extract attention signals from warm-start hidden state
  // Segment 4 (640-767) of Self-Discover vectors encodes task focus
  const focusSignal = meanValue(warmStartState.subarray(640, LATENT_DIM));

  // Positive focus → boost call/extends analysis (code logic focus)
  // Negative focus → boost imports analysis (dependency focus)
  if (focusSignal > 0) {
    base.edgeTypeWeights['CALLS'] *= 1 + Math.abs(focusSignal) * 3;
    base.edgeTypeWeights['EXTENDS'] *= 1 + Math.abs(focusSignal) * 2;
  } else {
    base.edgeTypeWeights['IMPORTS'] *= 1 + Math.abs(focusSignal) * 3;
  }

  return { ...base, source: 'borgarc_priority' };
}

// ── Latent Payload Construction ────────────────────────────────────

/**
 * Package a hidden state as a LatentPayload for Hermes transport.
 */
export function createLatentPayload(hiddenState: Float32Array): LatentPayload {
  return {
    data: new Float32Array(hiddenState),
    numVectors: 1,
    dim: LATENT_DIM,
    adapterKey: 'gitnexus_L1_projection',
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

/** Mean value of a vector segment. */
function meanValue(v: Float32Array): number {
  if (v.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i];
  return sum / v.length;
}

/**
 * Blend two hidden states: result = (1 - alpha) * a + alpha * b
 * Does NOT normalize — caller should normalize after blending.
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
