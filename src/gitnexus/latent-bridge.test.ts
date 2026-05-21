/**
 * GitNexus Layer 1 - Latent Bridge Tests
 *
 * Tests all 5 RecursiveMAS modifications:
 *   1. Graph embedding projection
 *   2. Bidirectional state sync
 *   3. Recursive depth configuration
 *   4. Differentiable confidence proxy
 *   5. Selective graph attention initialization
 */

import { describe, test, expect } from 'vitest';
import { LATENT_DIM } from '../hermes/types.js';

import {
  extractGraphFeatures,
  projectGraphToLatent,
  processInboundSignal,
  getGraphRoundBudget,
  runGraphRecursion,
  computeStructuralConfidence,
  createUniformAttention,
  initAttentionFromAxWarmStart,
  createLatentPayload,
  GRAPH_ROUND_DEFAULTS,
} from './latent-bridge.js';

import type {
  GraphFeatures,
  GraphAttentionWeights,
  InboundSignal,
  Subgraph,
} from './latent-bridge.js';

// ── Test Fixtures ──────────────────────────────────────────────────

function makeSubgraph(nodeCount = 5, edgeCount = 8): Subgraph {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      label: i < nodeCount / 2 ? 'File' : 'Symbol',
      name: `node_${i}`,
      filePath: `src/file_${i}.ts`,
      kind: i >= nodeCount / 2 ? 'function' : undefined,
    });
  }

  const edges = [];
  for (let i = 0; i < edgeCount; i++) {
    const types = ['IMPORTS', 'CALLS', 'EXTENDS', 'DEFINED_IN'];
    edges.push({
      from: `node_${i % nodeCount}`,
      to: `node_${(i + 1) % nodeCount}`,
      type: types[i % types.length],
    });
  }

  return { nodes, edges };
}

function makeSignal(type: InboundSignal['signalType'] = 'vulnerability'): InboundSignal {
  const state = new Float32Array(LATENT_DIM);
  // Non-zero signal
  for (let i = 0; i < LATENT_DIM; i++) {
    state[i] = Math.sin(i / LATENT_DIM * Math.PI) * 0.1;
  }
  return {
    fromAgent: type === 'vulnerability' ? 'deepsec' : 'borgarc',
    fromLayer: type === 'vulnerability' ? 'L2' : 'L3',
    hiddenState: state,
    signalType: type,
  };
}

// ── Mod 1: Graph Embedding Projection ──────────────────────────────

describe('Mod 1: Graph Embedding Projection', () => {
  test('extractGraphFeatures returns correct counts', () => {
    const sg = makeSubgraph(6, 10);
    const features = extractGraphFeatures(sg);
    expect(features.nodeCount).toBe(6);
    expect(features.edgeCount).toBe(10);
    expect(features.nodeTypeDist).toHaveProperty('File');
    expect(features.nodeTypeDist).toHaveProperty('Symbol');
  });

  test('extractGraphFeatures handles empty subgraph', () => {
    const features = extractGraphFeatures({ nodes: [], edges: [] });
    expect(features.nodeCount).toBe(0);
    expect(features.edgeCount).toBe(0);
    expect(features.density).toBe(0);
    expect(features.connectivityScore).toBe(0);
  });

  test('projectGraphToLatent produces correct dimension', () => {
    const sg = makeSubgraph();
    const features = extractGraphFeatures(sg);
    const attention = createUniformAttention(sg);
    const vec = projectGraphToLatent(features, attention);
    expect(vec.length).toBe(LATENT_DIM);
  });

  test('projectGraphToLatent produces normalized vector', () => {
    const sg = makeSubgraph(10, 20);
    const features = extractGraphFeatures(sg);
    const attention = createUniformAttention(sg);
    const vec = projectGraphToLatent(features, attention);

    // Check unit norm (approximately 1.0)
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 2);
  });

  test('different subgraphs produce different embeddings', () => {
    const sg1 = makeSubgraph(5, 8);
    const sg2 = makeSubgraph(20, 50);
    const f1 = extractGraphFeatures(sg1);
    const f2 = extractGraphFeatures(sg2);
    const a1 = createUniformAttention(sg1);
    const a2 = createUniformAttention(sg2);

    const v1 = projectGraphToLatent(f1, a1);
    const v2 = projectGraphToLatent(f2, a2);

    // Vectors should differ
    let diff = 0;
    for (let i = 0; i < v1.length; i++) diff += Math.abs(v1[i] - v2[i]);
    expect(diff).toBeGreaterThan(0.1);
  });

  test('density computed correctly for directed graph', () => {
    // 4 nodes, 6 edges → density = 6 / (4 * 3) = 0.5
    const sg: Subgraph = {
      nodes: [
        { label: 'File', name: 'a' },
        { label: 'File', name: 'b' },
        { label: 'File', name: 'c' },
        { label: 'File', name: 'd' },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'IMPORTS' },
        { from: 'a', to: 'c', type: 'IMPORTS' },
        { from: 'b', to: 'c', type: 'IMPORTS' },
        { from: 'c', to: 'd', type: 'IMPORTS' },
        { from: 'd', to: 'a', type: 'IMPORTS' },
        { from: 'b', to: 'd', type: 'CALLS' },
      ],
    };
    const features = extractGraphFeatures(sg);
    expect(features.density).toBeCloseTo(0.5, 2);
  });

  test('hasInheritance flag set when EXTENDS edges present', () => {
    const sg: Subgraph = {
      nodes: [{ label: 'Symbol', name: 'a' }, { label: 'Symbol', name: 'b' }],
      edges: [{ from: 'a', to: 'b', type: 'EXTENDS' }],
    };
    const features = extractGraphFeatures(sg);
    expect(features.hasInheritance).toBe(true);
  });
});

// ── Mod 2: Bidirectional State Sync ────────────────────────────────

describe('Mod 2: Bidirectional State Sync', () => {
  test('vulnerability signal boosts CALLS and IMPORTS weights', () => {
    const sg = makeSubgraph();
    const attention = createUniformAttention(sg);
    const signal = makeSignal('vulnerability');

    const updated = processInboundSignal(attention, signal);
    expect(updated.edgeTypeWeights['CALLS']).toBeGreaterThan(1.0);
    expect(updated.edgeTypeWeights['IMPORTS']).toBeGreaterThan(1.0);
    expect(updated.source).toBe('deepsec_signal');
  });

  test('acquisition priority signal adjusts edge weights', () => {
    const sg = makeSubgraph();
    const attention = createUniformAttention(sg);
    const signal = makeSignal('acquisition_priority');

    const updated = processInboundSignal(attention, signal);
    // At least one edge type should be boosted
    const maxWeight = Math.max(...Object.values(updated.edgeTypeWeights));
    expect(maxWeight).toBeGreaterThan(1.0);
    expect(updated.source).toBe('borgarc_priority');
  });

  test('structural feedback returns round_refined source', () => {
    const sg = makeSubgraph();
    const attention = createUniformAttention(sg);
    const signal: InboundSignal = {
      fromAgent: 'deepsec',
      fromLayer: 'L2',
      hiddenState: new Float32Array(LATENT_DIM),
      signalType: 'structural_feedback',
    };

    const updated = processInboundSignal(attention, signal);
    expect(updated.source).toBe('round_refined');
  });
});

// ── Mod 3: Recursive Depth Configuration ───────────────────────────

describe('Mod 3: Recursive Depth Configuration', () => {
  test('complexity-derived round budgets match locked values', () => {
    expect(getGraphRoundBudget('linear')).toBe(3);
    expect(getGraphRoundBudget('moderate')).toBe(4);
    expect(getGraphRoundBudget('complex')).toBe(8);
  });

  test('default round budget for standard analysis', () => {
    expect(getGraphRoundBudget()).toBe(GRAPH_ROUND_DEFAULTS.standard);
  });

  test('security-adjacent gets higher budget', () => {
    expect(getGraphRoundBudget(undefined, true)).toBe(GRAPH_ROUND_DEFAULTS.securityAdjacent);
  });

  test('runGraphRecursion executes correct number of rounds', () => {
    const sg = makeSubgraph();
    const result = runGraphRecursion({
      taskId: 'test-task-1',
      subgraph: sg,
      maxRounds: 3,
    });

    expect(result.roundsExecuted).toBeLessThanOrEqual(3);
    expect(result.roundsExecuted).toBeGreaterThan(0);
    expect(result.rounds.length).toBe(result.roundsExecuted);
  });

  test('runGraphRecursion converges early when state stabilizes', () => {
    // Identical subgraph each round = same projection = convergence after round 1
    const sg = makeSubgraph(10, 20);
    const result = runGraphRecursion({
      taskId: 'test-converge',
      subgraph: sg,
      maxRounds: 8,
    });

    // Same graph, no inbound signals → state identical each round → converges
    expect(result.converged).toBe(true);
    expect(result.roundsExecuted).toBeLessThan(8);
  });

  test('runGraphRecursion writes traces', () => {
    const sg = makeSubgraph();
    const result = runGraphRecursion({
      taskId: `test-trace-${Date.now()}`,
      subgraph: sg,
      maxRounds: 2,
    });

    // Each round should have produced a trace
    expect(result.rounds.length).toBeGreaterThan(0);
    for (const round of result.rounds) {
      expect(round.hiddenState.length).toBe(LATENT_DIM);
    }
  });

  test('runGraphRecursion incorporates inbound signals', () => {
    const sg = makeSubgraph(10, 20);
    const signal = makeSignal('vulnerability');

    const withSignal = runGraphRecursion({
      taskId: 'test-with-signal',
      subgraph: sg,
      maxRounds: 3,
      inboundSignals: [signal],
    });

    const withoutSignal = runGraphRecursion({
      taskId: 'test-without-signal',
      subgraph: sg,
      maxRounds: 3,
    });

    // Final states should differ due to signal blending
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) {
      diff += Math.abs(withSignal.finalState[i] - withoutSignal.finalState[i]);
    }
    expect(diff).toBeGreaterThan(0.01);
  });
});

// ── Mod 4: Differentiable Confidence Proxy ─────────────────────────

describe('Mod 4: Differentiable Confidence Proxy', () => {
  test('confidence is between 0 and 1', () => {
    const features = extractGraphFeatures(makeSubgraph());
    const state = new Float32Array(LATENT_DIM);
    const conf = computeStructuralConfidence(features, state);
    expect(conf).toBeGreaterThanOrEqual(0);
    expect(conf).toBeLessThanOrEqual(1);
  });

  test('confidence increases with impact data', () => {
    const features = extractGraphFeatures(makeSubgraph());
    const state = new Float32Array(LATENT_DIM);

    const confWithout = computeStructuralConfidence(features, state);
    const confWith = computeStructuralConfidence(features, state, {
      directDependents: ['a.ts', 'b.ts', 'c.ts'],
      callers: [],
      totalImpact: 15,
    });

    expect(confWith).toBeGreaterThan(confWithout);
  });

  test('confidence is deterministic', () => {
    const features = extractGraphFeatures(makeSubgraph(8, 15));
    const state = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) state[i] = Math.sin(i) * 0.1;

    const c1 = computeStructuralConfidence(features, state);
    const c2 = computeStructuralConfidence(features, state);
    expect(c1).toBe(c2);
  });
});

// ── Mod 5: Selective Graph Attention Initialization ────────────────

describe('Mod 5: Selective Graph Attention Initialization', () => {
  test('uniform attention sets all weights to 1.0', () => {
    const sg = makeSubgraph();
    const attention = createUniformAttention(sg);
    expect(attention.source).toBe('uniform');
    expect(attention.edgeTypeWeights['IMPORTS']).toBe(1.0);
    expect(attention.edgeTypeWeights['CALLS']).toBe(1.0);
    expect(attention.edgeTypeWeights['EXTENDS']).toBe(1.0);
    expect(attention.edgeTypeWeights['DEFINED_IN']).toBe(1.0);
  });

  test('warm-start from Ax adjusts edge type weights', () => {
    const sg = makeSubgraph();
    const warmState = new Float32Array(LATENT_DIM);
    // Create a non-trivial warm-start signal in segment 4 (640-767)
    for (let i = 640; i < LATENT_DIM; i++) {
      warmState[i] = 0.5;
    }

    const attention = initAttentionFromAxWarmStart(sg, warmState);
    // Positive focus signal → should boost CALLS
    expect(attention.edgeTypeWeights['CALLS']).toBeGreaterThan(1.0);
  });

  test('warm-start with negative focus boosts IMPORTS', () => {
    const sg = makeSubgraph();
    const warmState = new Float32Array(LATENT_DIM);
    for (let i = 640; i < LATENT_DIM; i++) {
      warmState[i] = -0.5;
    }

    const attention = initAttentionFromAxWarmStart(sg, warmState);
    expect(attention.edgeTypeWeights['IMPORTS']).toBeGreaterThan(1.0);
  });
});

// ── Latent Payload ─────────────────────────────────────────────────

describe('Latent Payload Construction', () => {
  test('createLatentPayload has correct structure', () => {
    const state = new Float32Array(LATENT_DIM);
    const payload = createLatentPayload(state);
    expect(payload.dim).toBe(LATENT_DIM);
    expect(payload.numVectors).toBe(1);
    expect(payload.data.length).toBe(LATENT_DIM);
    expect(payload.adapterKey).toBe('gitnexus_L1_projection');
    expect(payload.sourceHiddenSize).toBe(LATENT_DIM);
  });

  test('runGraphRecursion returns valid payload', () => {
    const result = runGraphRecursion({
      taskId: 'test-payload',
      subgraph: makeSubgraph(),
      maxRounds: 2,
    });
    expect(result.payload.dim).toBe(LATENT_DIM);
    expect(result.payload.data.length).toBe(LATENT_DIM);
  });
});

// ── Integration ────────────────────────────────────────────────────

describe('Full Pipeline Integration', () => {
  test('end-to-end: subgraph → features → projection → recursion → payload', () => {
    const sg = makeSubgraph(15, 30);
    const result = runGraphRecursion({
      taskId: 'test-e2e',
      subgraph: sg,
      maxRounds: 4,
      inboundSignals: [makeSignal('vulnerability')],
    });

    // All fields populated
    expect(result.taskId).toBe('test-e2e');
    expect(result.finalState.length).toBe(LATENT_DIM);
    expect(result.finalConfidence).toBeGreaterThan(0);
    expect(result.payload.dim).toBe(LATENT_DIM);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.roundsExecuted).toBeLessThanOrEqual(4);
  });
});
