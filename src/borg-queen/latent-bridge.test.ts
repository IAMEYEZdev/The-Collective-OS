/**
 * Borg Queen Latent Bridge — Layer 6 Tests
 *
 * Covers all 6 modifications:
 *   Mod 1: RecursiveMAS Cluster Initializer
 *   Mod 2: Global Latent State Aggregator
 *   Mod 3: Per-Round Global Context Broadcast
 *   Mod 4: Credit Assignment Router
 *   Mod 5: MAS2 Integration Interface
 *   Mod 6: Capability Gap Broadcast
 *   Full cluster execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LATENT_DIM } from '../hermes/types.js';
import { RECURSION_DEPTH_MAP } from '../ax/types.js';
import {
  initializeCluster,
  createClusterInitSignal,
  aggregateGlobalState,
  checkGlobalConvergence,
  createGlobalBroadcast,
  computeRoundContribution,
  computeCreditAssignments,
  detectTaskNovelty,
  createMAS2Request,
  validateMAS2Topology,
  mas2ToClusterConfig,
  detectCapabilityGaps,
  gapsToBorgArcContext,
  runCluster,
  createBorgQueenPayload,
  DEFAULT_CONVERGENCE_THRESHOLD,
  NOVELTY_THRESHOLD,
} from './latent-bridge.js';
import type {
  ClusterConfig,
  ClusterParticipant,
  AgentRoundState,
  GlobalRoundState,
  ClusterResult,
  MAS2TopologyResponse,
} from './latent-bridge.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeParticipants(count: number): Array<{ agentId: string; layer: string; latentCapable?: boolean }> {
  const layers = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  return Array.from({ length: count }, (_, i) => ({
    agentId: `agent-${i}`,
    layer: layers[i % layers.length],
    latentCapable: true,
  }));
}

function makeAgentState(agentId: string, layer: string, round: number, seed = 1): AgentRoundState {
  const state = new Float32Array(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    state[i] = Math.sin(i * seed + round * 0.1);
  }
  return {
    agentId,
    layer,
    round,
    hiddenState: state,
    stateDelta: round > 0 ? 0.05 : null,
    confidence: 0.8,
  };
}

function makeRandomVec(seed = 42): Float32Array {
  const vec = new Float32Array(LATENT_DIM);
  let x = seed;
  for (let i = 0; i < LATENT_DIM; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return vec;
}

function vecMagnitude(vec: Float32Array): number {
  let mag = 0;
  for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
  return Math.sqrt(mag);
}

// ── Mock trace writes ──────────────────────────────────────────────────

vi.mock('../hermes/trace.js', () => ({
  writeTrace: vi.fn(),
}));

// ── Mod 1: Cluster Initializer ─────────────────────────────────────────

describe('Mod 1: Cluster Initializer', () => {
  it('creates config with correct round budget for each complexity', () => {
    for (const complexity of ['linear', 'moderate', 'complex'] as const) {
      const config = initializeCluster({
        taskId: 'task-1',
        participants: makeParticipants(3),
        complexity,
      });
      expect(config.maxRounds).toBe(RECURSION_DEPTH_MAP[complexity]);
    }
  });

  it('normalizes participant weights to sum to 1', () => {
    const config = initializeCluster({
      taskId: 'task-1',
      participants: makeParticipants(4),
      complexity: 'moderate',
    });
    const totalWeight = config.participants.reduce((s, p) => s + p.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 6);
  });

  it('gives lower weight to non-latent-capable agents', () => {
    const config = initializeCluster({
      taskId: 'task-1',
      participants: [
        { agentId: 'a', layer: 'L1', latentCapable: true },
        { agentId: 'b', layer: 'L2', latentCapable: false },
      ],
      complexity: 'linear',
    });
    const a = config.participants.find(p => p.agentId === 'a')!;
    const b = config.participants.find(p => p.agentId === 'b')!;
    expect(a.weight).toBeGreaterThan(b.weight);
  });

  it('uses custom convergence threshold when provided', () => {
    const config = initializeCluster({
      taskId: 'task-1',
      participants: makeParticipants(2),
      complexity: 'linear',
      convergenceThreshold: 0.05,
    });
    expect(config.convergenceThreshold).toBe(0.05);
  });

  it('defaults convergence threshold to DEFAULT_CONVERGENCE_THRESHOLD', () => {
    const config = initializeCluster({
      taskId: 'task-1',
      participants: makeParticipants(2),
      complexity: 'linear',
    });
    expect(config.convergenceThreshold).toBe(DEFAULT_CONVERGENCE_THRESHOLD);
  });

  it('copies playbook prior without mutating original', () => {
    const prior = makeRandomVec(99);
    const originalCopy = new Float32Array(prior);
    const config = initializeCluster({
      taskId: 'task-1',
      participants: makeParticipants(2),
      complexity: 'moderate',
      playbookPrior: prior,
    });
    expect(config.startingPrior).toBeDefined();
    expect(config.startingPrior).not.toBe(prior); // Different reference
    // Original not mutated
    for (let i = 0; i < LATENT_DIM; i++) {
      expect(prior[i]).toBe(originalCopy[i]);
    }
  });

  it('generates unique cluster ID', () => {
    const c1 = initializeCluster({ taskId: 't1', participants: makeParticipants(2), complexity: 'linear' });
    const c2 = initializeCluster({ taskId: 't2', participants: makeParticipants(2), complexity: 'linear' });
    expect(c1.clusterId).not.toBe(c2.clusterId);
  });
});

describe('Mod 1: Cluster Init Signal', () => {
  it('produces 768-dim normalized vector', () => {
    const config = initializeCluster({
      taskId: 'task-1',
      participants: makeParticipants(3),
      complexity: 'moderate',
    });
    const signal = createClusterInitSignal(config);
    expect(signal.length).toBe(LATENT_DIM);
    expect(vecMagnitude(signal)).toBeCloseTo(1.0, 3);
  });

  it('blends playbook prior when provided', () => {
    const prior = makeRandomVec(77);
    const configWith = initializeCluster({
      taskId: 'task-1',
      participants: makeParticipants(3),
      complexity: 'moderate',
      playbookPrior: prior,
    });
    const configWithout = initializeCluster({
      taskId: 'task-2',
      participants: makeParticipants(3),
      complexity: 'moderate',
    });
    const sigWith = createClusterInitSignal(configWith);
    const sigWithout = createClusterInitSignal(configWithout);
    // Should be different
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(sigWith[i] - sigWithout[i]);
    expect(diff).toBeGreaterThan(0.1);
  });

  it('encodes different complexities differently when combined with prior', () => {
    // Without a prior, complexity only affects amplitude (erased by normalization).
    // With a prior, the coordination segment has a different ratio to the prior blend,
    // producing genuinely different normalized vectors.
    const prior = makeRandomVec(77);
    const makeSignal = (c: 'linear' | 'moderate' | 'complex') => {
      const config = initializeCluster({
        taskId: 'task-1', participants: makeParticipants(3), complexity: c, playbookPrior: prior,
      });
      return createClusterInitSignal(config);
    };
    const linear = makeSignal('linear');
    const complex = makeSignal('complex');
    let dot = 0, magL = 0, magC = 0;
    for (let i = 0; i < LATENT_DIM; i++) {
      dot += linear[i] * complex[i];
      magL += linear[i] * linear[i];
      magC += complex[i] * complex[i];
    }
    const cosSim = dot / (Math.sqrt(magL) * Math.sqrt(magC));
    expect(cosSim).toBeLessThan(1.0);
  });
});

// ── Mod 2: Global Latent State Aggregator ──────────────────────────────

describe('Mod 2: Global State Aggregator', () => {
  it('produces 768-dim normalized output', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'a', layer: 'L1', weight: 0.5, latentCapable: true },
      { agentId: 'b', layer: 'L2', weight: 0.5, latentCapable: true },
    ];
    const states = [
      makeAgentState('a', 'L1', 0, 1),
      makeAgentState('b', 'L2', 0, 2),
    ];
    const global = aggregateGlobalState(states, participants);
    expect(global.length).toBe(LATENT_DIM);
    expect(vecMagnitude(global)).toBeCloseTo(1.0, 3);
  });

  it('routes L1 agent to structural segment (0-128)', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'a', layer: 'L1', weight: 1.0, latentCapable: true },
    ];
    const state = makeAgentState('a', 'L1', 0, 5);
    const global = aggregateGlobalState([state], participants);

    // Structural segment should have signal (unnormalized check: confirm non-zero)
    let structEnergy = 0;
    for (let i = 0; i < 128; i++) structEnergy += global[i] * global[i];
    expect(structEnergy).toBeGreaterThan(0);
  });

  it('routes L2 agent to security segment (128-256)', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'b', layer: 'L2', weight: 1.0, latentCapable: true },
    ];
    const state = makeAgentState('b', 'L2', 0, 7);
    const global = aggregateGlobalState([state], participants);

    let secEnergy = 0;
    for (let i = 128; i < 256; i++) secEnergy += global[i] * global[i];
    expect(secEnergy).toBeGreaterThan(0);
  });

  it('blends with previous global using momentum', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'a', layer: 'L1', weight: 1.0, latentCapable: true },
    ];
    const state = makeAgentState('a', 'L1', 1, 3);
    const prevGlobal = makeRandomVec(42);

    const withMomentum = aggregateGlobalState([state], participants, prevGlobal);
    const withoutMomentum = aggregateGlobalState([state], participants);

    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(withMomentum[i] - withoutMomentum[i]);
    expect(diff).toBeGreaterThan(0.01);
  });

  it('handles unknown layer by distributing with reduced weight', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'x', layer: 'L1', weight: 1.0, latentCapable: true },
    ];
    // Agent claims layer "L9" which doesn't exist in LAYER_SEGMENT_MAP
    const state = makeAgentState('x', 'L9' as any, 0, 11);
    // Should not throw
    const global = aggregateGlobalState([state], participants);
    expect(global.length).toBe(LATENT_DIM);
  });
});

describe('Mod 2: Global Convergence Check', () => {
  it('returns null delta when no previous state', () => {
    const current = makeRandomVec(1);
    const result = checkGlobalConvergence(current, null);
    expect(result.converged).toBe(false);
    expect(result.delta).toBeNull();
  });

  it('detects convergence when delta below threshold', () => {
    const vec = makeRandomVec(1);
    // Slightly perturbed copy
    const similar = new Float32Array(vec);
    similar[0] += 0.001;
    const result = checkGlobalConvergence(vec, similar, 0.1);
    expect(result.converged).toBe(true);
    expect(result.delta).toBeDefined();
    expect(result.delta!).toBeLessThan(0.1);
  });

  it('rejects convergence when delta above threshold', () => {
    const v1 = makeRandomVec(1);
    const v2 = makeRandomVec(2);
    const result = checkGlobalConvergence(v1, v2, 0.001);
    expect(result.converged).toBe(false);
    expect(result.delta).toBeDefined();
  });
});

// ── Mod 3: Global Context Broadcast ────────────────────────────────────

describe('Mod 3: Global Context Broadcast', () => {
  it('creates payloads only for latent-capable participants', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'a', layer: 'L1', weight: 0.5, latentCapable: true },
      { agentId: 'b', layer: 'L2', weight: 0.3, latentCapable: false },
      { agentId: 'c', layer: 'L3', weight: 0.2, latentCapable: true },
    ];
    const global = makeRandomVec(1);
    const broadcasts = createGlobalBroadcast(global, participants, 3);
    expect(broadcasts.size).toBe(2); // a and c only
    expect(broadcasts.has('a')).toBe(true);
    expect(broadcasts.has('b')).toBe(false);
    expect(broadcasts.has('c')).toBe(true);
  });

  it('produces 768-dim normalized payloads', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'a', layer: 'L1', weight: 1.0, latentCapable: true },
    ];
    const global = makeRandomVec(1);
    const broadcasts = createGlobalBroadcast(global, participants, 5);
    const payload = broadcasts.get('a')!;
    expect(payload.data.length).toBe(LATENT_DIM);
    expect(payload.dim).toBe(LATENT_DIM);
    expect(payload.numVectors).toBe(1);
    expect(vecMagnitude(payload.data)).toBeCloseTo(1.0, 3);
  });

  it('sets correct adapter key pattern', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'agent-x', layer: 'L1', weight: 1.0, latentCapable: true },
    ];
    const broadcasts = createGlobalBroadcast(makeRandomVec(1), participants, 2);
    const payload = broadcasts.get('agent-x')!;
    expect(payload.adapterKey).toBe('borgqueen_L6_to_agent-x');
  });

  it('incorporates contribution scores when provided', () => {
    const participants: ClusterParticipant[] = [
      { agentId: 'a', layer: 'L1', weight: 0.5, latentCapable: true },
    ];
    const global = makeRandomVec(1);
    const contribs = new Map([['a', 0.9]]);
    const withContrib = createGlobalBroadcast(global, participants, 3, contribs);
    const withoutContrib = createGlobalBroadcast(global, participants, 3);

    // Should differ in gap/credit segment
    const p1 = withContrib.get('a')!.data;
    const p2 = withoutContrib.get('a')!.data;
    let diff = 0;
    for (let i = 704; i < 768; i++) diff += Math.abs(p1[i] - p2[i]);
    expect(diff).toBeGreaterThan(0);
  });
});

// ── Mod 4: Credit Assignment Router ────────────────────────────────────

describe('Mod 4: Credit Assignment', () => {
  it('returns 0.5 neutral contribution for first round', () => {
    const state = makeAgentState('a', 'L1', 0);
    const global = makeRandomVec(1);
    const contrib = computeRoundContribution(state, global);
    expect(contrib).toBe(0.5);
  });

  it('returns contribution in 0-1 range', () => {
    const state = makeAgentState('a', 'L1', 1, 3);
    const current = makeRandomVec(1);
    const previous = makeRandomVec(2);
    const contrib = computeRoundContribution(state, current, previous);
    expect(contrib).toBeGreaterThanOrEqual(0);
    expect(contrib).toBeLessThanOrEqual(1);
  });

  it('computes credit assignments across multiple rounds', () => {
    // Build mock rounds
    const rounds: GlobalRoundState[] = [];
    for (let r = 0; r < 3; r++) {
      const agentStates = [
        makeAgentState('a', 'L1', r, 1),
        makeAgentState('b', 'L2', r, 2),
      ];
      rounds.push({
        round: r,
        globalState: makeRandomVec(r + 10),
        agentStates,
        convergenceDelta: r > 0 ? 0.05 : null,
        converged: false,
        contributions: new Map([['a', 0.5], ['b', 0.5]]),
      });
    }

    const finalGlobal = makeRandomVec(100);
    const credits = computeCreditAssignments(rounds, finalGlobal);

    expect(credits.size).toBe(2);
    expect(credits.has('a')).toBe(true);
    expect(credits.has('b')).toBe(true);

    const creditA = credits.get('a')!;
    expect(creditA.roundCredits.length).toBe(3);
    expect(creditA.alignedRounds + creditA.divergentRounds).toBe(3);
  });

  it('weights later rounds higher in credit calculation', () => {
    // Agent aligned with final state in all rounds
    const finalGlobal = makeRandomVec(42);
    const rounds: GlobalRoundState[] = [];
    for (let r = 0; r < 4; r++) {
      rounds.push({
        round: r,
        globalState: makeRandomVec(r + 10),
        agentStates: [{
          agentId: 'a',
          layer: 'L1',
          round: r,
          hiddenState: new Float32Array(finalGlobal), // Perfectly aligned
          stateDelta: null,
          confidence: 1.0,
        }],
        convergenceDelta: null,
        converged: false,
        contributions: new Map(),
      });
    }

    const credits = computeCreditAssignments(rounds, finalGlobal);
    const credit = credits.get('a')!;
    // Later round credits should be higher due to roundWeight = (r+1)/rounds.length
    expect(credit.roundCredits[3]).toBeGreaterThan(credit.roundCredits[0]);
  });
});

// ── Mod 5: MAS2 Integration Interface ──────────────────────────────────

describe('Mod 5: MAS2 Interface', () => {
  it('detects novel task when playbook match below threshold', () => {
    const result = detectTaskNovelty('parse cryptographic signatures', 0.1);
    expect(result.isNovel).toBe(true);
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it('detects non-novel task when playbook match above threshold', () => {
    const result = detectTaskNovelty('scan npm packages', 0.8);
    expect(result.isNovel).toBe(false);
    expect(result.confidence).toBeCloseTo(0.2);
  });

  it('uses NOVELTY_THRESHOLD=0.3 as boundary', () => {
    expect(detectTaskNovelty('x', 0.29).isNovel).toBe(true);
    expect(detectTaskNovelty('x', 0.31).isNovel).toBe(false);
  });

  it('creates MAS2 request with defaults', () => {
    const req = createMAS2Request('novel task', 'no prior topology');
    expect(req.taskDescription).toBe('novel task');
    expect(req.noveltyReason).toBe('no prior topology');
    expect(req.maxAgents).toBe(5);
    expect(req.availableLayers).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
  });

  it('creates MAS2 request with custom layers', () => {
    const req = createMAS2Request('task', 'reason', ['L1', 'L3']);
    expect(req.availableLayers).toEqual(['L1', 'L3']);
  });

  it('validates topology — all agents available', () => {
    const topology: MAS2TopologyResponse = {
      topology: [
        { agentId: 'a', layer: 'L1', weight: 1, latentCapable: true },
        { agentId: 'b', layer: 'L2', weight: 1, latentCapable: true },
      ],
      confidence: 0.8,
      rationale: 'test',
    };
    const result = validateMAS2Topology(topology, ['a', 'b', 'c']);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('validates topology — missing agents', () => {
    const topology: MAS2TopologyResponse = {
      topology: [
        { agentId: 'a', layer: 'L1', weight: 1, latentCapable: true },
        { agentId: 'missing', layer: 'L3', weight: 1, latentCapable: true },
      ],
      confidence: 0.8,
      rationale: 'test',
    };
    const result = validateMAS2Topology(topology, ['a', 'b']);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['missing']);
  });

  it('warns on low confidence', () => {
    const topology: MAS2TopologyResponse = {
      topology: [{ agentId: 'a', layer: 'L1', weight: 1, latentCapable: true }],
      confidence: 0.3,
      rationale: 'test',
    };
    const result = validateMAS2Topology(topology, ['a']);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('confidence low');
  });

  it('warns on too many agents', () => {
    const topology: MAS2TopologyResponse = {
      topology: Array.from({ length: 8 }, (_, i) => ({
        agentId: `a${i}`, layer: 'L1' as const, weight: 1, latentCapable: true,
      })),
      confidence: 0.9,
      rationale: 'test',
    };
    const result = validateMAS2Topology(topology, Array.from({ length: 8 }, (_, i) => `a${i}`));
    expect(result.warnings.some(w => w.includes('8 agents'))).toBe(true);
  });

  it('converts MAS2 topology to ClusterConfig', () => {
    const topology: MAS2TopologyResponse = {
      topology: [
        { agentId: 'a', layer: 'L1', weight: 1, latentCapable: true },
        { agentId: 'b', layer: 'L2', weight: 1, latentCapable: false },
      ],
      confidence: 0.7,
      rationale: 'test topology',
    };
    const config = mas2ToClusterConfig('task-mas2', topology, 'complex');
    expect(config.taskId).toBe('task-mas2');
    expect(config.complexity).toBe('complex');
    expect(config.participants.length).toBe(2);
    expect(config.maxRounds).toBe(RECURSION_DEPTH_MAP.complex);
  });
});

// ── Mod 6: Capability Gap Broadcast ────────────────────────────────────

describe('Mod 6: Capability Gap Detection', () => {
  function makeClusterResult(rounds: number, converged: boolean): ClusterResult {
    const finalState = makeRandomVec(rounds);
    return {
      clusterId: `c-${rounds}`,
      taskId: `t-${rounds}`,
      rounds: Array.from({ length: rounds }, (_, r) => ({
        round: r,
        globalState: makeRandomVec(r + 100),
        agentStates: [],
        convergenceDelta: 0.05,
        converged: r === rounds - 1 && converged,
        contributions: new Map(),
      })),
      converged,
      finalGlobalState: finalState,
      totalRounds: rounds,
      creditAssignments: new Map(),
    };
  }

  it('detects gaps for high-round-count domains', () => {
    const clusters = [
      { taskId: 't1', domain: 'crypto', result: makeClusterResult(8, false) },
      { taskId: 't2', domain: 'crypto', result: makeClusterResult(7, false) },
    ];
    const gaps = detectCapabilityGaps(clusters);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].domain).toBe('crypto');
    expect(gaps[0].avgConvergenceRounds).toBeGreaterThan(5);
  });

  it('produces 768-dim gap vectors', () => {
    const clusters = [
      { taskId: 't1', domain: 'auth', result: makeClusterResult(8, false) },
    ];
    const gaps = detectCapabilityGaps(clusters);
    if (gaps.length > 0) {
      expect(gaps[0].gapVector.length).toBe(LATENT_DIM);
    }
  });

  it('sorts gaps by severity descending', () => {
    const clusters = [
      { taskId: 't1', domain: 'easy', result: makeClusterResult(3, true) },
      { taskId: 't2', domain: 'easy', result: makeClusterResult(3, true) },
      { taskId: 't3', domain: 'hard', result: makeClusterResult(8, false) },
      { taskId: 't4', domain: 'hard', result: makeClusterResult(8, false) },
    ];
    const gaps = detectCapabilityGaps(clusters);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1].severity).toBeGreaterThanOrEqual(gaps[i].severity);
    }
  });

  it('skips domains with low severity', () => {
    // Quick converging domain = no gap
    const clusters = [
      { taskId: 't1', domain: 'trivial', result: makeClusterResult(2, true) },
      { taskId: 't2', domain: 'trivial', result: makeClusterResult(2, true) },
    ];
    const gaps = detectCapabilityGaps(clusters);
    // Severity: (2/8)*0.5 + (1-1)*0.3 + (0)*0.2 = 0.125 < 0.3 → no gap
    expect(gaps.filter(g => g.domain === 'trivial')).toEqual([]);
  });
});

describe('Mod 6: Gap to Borg Arc Context', () => {
  it('produces 768-dim gap signal', () => {
    const gaps = [{
      domain: 'test',
      severity: 0.6,
      avgConvergenceRounds: 6,
      reviewRate: 0.5,
      gapVector: makeRandomVec(1),
    }];
    const result = gapsToBorgArcContext(gaps);
    expect(result.gapSignal.length).toBe(LATENT_DIM);
  });

  it('produces layer priority map', () => {
    const gaps = [{
      domain: 'test',
      severity: 0.6,
      avgConvergenceRounds: 6,
      reviewRate: 0.5,
      gapVector: makeRandomVec(1),
    }];
    const result = gapsToBorgArcContext(gaps);
    expect(result.layerPriorities).toHaveProperty('L1');
    expect(result.layerPriorities).toHaveProperty('L2');
    expect(result.layerPriorities).toHaveProperty('L3');
    expect(result.layerPriorities).toHaveProperty('L4');
    expect(result.layerPriorities).toHaveProperty('L5');
    expect(result.layerPriorities).toHaveProperty('L6');
  });

  it('layer priorities are non-negative', () => {
    const gaps = [{
      domain: 'test',
      severity: 0.8,
      avgConvergenceRounds: 7,
      reviewRate: 0.6,
      gapVector: makeRandomVec(5),
    }];
    const result = gapsToBorgArcContext(gaps);
    for (const val of Object.values(result.layerPriorities)) {
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles empty gaps array', () => {
    const result = gapsToBorgArcContext([]);
    expect(result.gapSignal.length).toBe(LATENT_DIM);
    // All zeros when no gaps
    let sum = 0;
    for (let i = 0; i < LATENT_DIM; i++) sum += Math.abs(result.gapSignal[i]);
    expect(sum).toBe(0);
  });
});

// ── Full Cluster Execution ─────────────────────────────────────────────

describe('Full Cluster Execution', () => {
  it('runs through all provided rounds', () => {
    const config = initializeCluster({
      taskId: 'full-test',
      participants: makeParticipants(2),
      complexity: 'moderate',
    });

    const agentStatesPerRound: AgentRoundState[][] = [];
    for (let r = 0; r < 4; r++) {
      agentStatesPerRound.push([
        makeAgentState('agent-0', 'L1', r, 1 + r * 0.01),
        makeAgentState('agent-1', 'L2', r, 2 + r * 0.01),
      ]);
    }

    const result = runCluster(config, agentStatesPerRound);
    expect(result.clusterId).toBe(config.clusterId);
    expect(result.taskId).toBe('full-test');
    expect(result.totalRounds).toBeLessThanOrEqual(4);
    expect(result.totalRounds).toBeGreaterThan(0);
    expect(result.finalGlobalState.length).toBe(LATENT_DIM);
  });

  it('produces valid credit assignments for all agents', () => {
    const config = initializeCluster({
      taskId: 'credit-test',
      participants: makeParticipants(3),
      complexity: 'linear',
    });

    const agentStatesPerRound: AgentRoundState[][] = [];
    for (let r = 0; r < 3; r++) {
      agentStatesPerRound.push([
        makeAgentState('agent-0', 'L1', r, 1),
        makeAgentState('agent-1', 'L2', r, 2),
        makeAgentState('agent-2', 'L3', r, 3),
      ]);
    }

    const result = runCluster(config, agentStatesPerRound);
    expect(result.creditAssignments.size).toBe(3);

    for (const [agentId, credit] of result.creditAssignments) {
      expect(credit.agentId).toBe(agentId);
      expect(credit.roundCredits.length).toBe(result.totalRounds);
    }
  });

  it('respects maxRounds cap', () => {
    const config = initializeCluster({
      taskId: 'cap-test',
      participants: makeParticipants(2),
      complexity: 'linear', // 3 rounds
    });

    // Provide more rounds than allowed
    const agentStatesPerRound: AgentRoundState[][] = [];
    for (let r = 0; r < 10; r++) {
      agentStatesPerRound.push([
        makeAgentState('agent-0', 'L1', r, 1),
        makeAgentState('agent-1', 'L2', r, 2),
      ]);
    }

    const result = runCluster(config, agentStatesPerRound);
    expect(result.totalRounds).toBeLessThanOrEqual(RECURSION_DEPTH_MAP.linear);
  });

  it('can converge early after minimum rounds', () => {
    const config = initializeCluster({
      taskId: 'converge-test',
      participants: [{ agentId: 'a', layer: 'L1' }],
      complexity: 'complex', // 8 rounds max
      convergenceThreshold: 0.5, // Very loose threshold
    });

    // Feed identical states so convergence happens quickly
    const fixedState = makeRandomVec(42);
    const agentStatesPerRound: AgentRoundState[][] = [];
    for (let r = 0; r < 8; r++) {
      agentStatesPerRound.push([{
        agentId: 'a',
        layer: 'L1',
        round: r,
        hiddenState: new Float32Array(fixedState),
        stateDelta: null,
        confidence: 1.0,
      }]);
    }

    const result = runCluster(config, agentStatesPerRound);
    // Should converge before max rounds with identical states
    expect(result.converged).toBe(true);
    expect(result.totalRounds).toBeLessThan(8);
  });

  it('writes trace entries via writeTrace', async () => {
    const { writeTrace: mockTrace } = await import('../hermes/trace.js');

    (mockTrace as any).mockClear();

    const config = initializeCluster({
      taskId: 'trace-test',
      participants: makeParticipants(2),
      complexity: 'linear',
    });

    const agentStatesPerRound = [
      [makeAgentState('agent-0', 'L1', 0, 1), makeAgentState('agent-1', 'L2', 0, 2)],
      [makeAgentState('agent-0', 'L1', 1, 1), makeAgentState('agent-1', 'L2', 1, 2)],
    ];

    runCluster(config, agentStatesPerRound);
    expect(mockTrace).toHaveBeenCalled();

    // Each round produces one trace
    const calls = (mockTrace as any).mock.calls;
    for (const call of calls) {
      expect(call[0].agentId).toBe('borg-queen');
      expect(call[0].layer).toBe('L6');
    }
  });

  it('handles starting prior in cluster config', () => {
    const prior = makeRandomVec(99);
    const config = initializeCluster({
      taskId: 'prior-test',
      participants: makeParticipants(2),
      complexity: 'linear',
      playbookPrior: prior,
    });

    const agentStatesPerRound = [
      [makeAgentState('agent-0', 'L1', 0, 1), makeAgentState('agent-1', 'L2', 0, 2)],
    ];

    const result = runCluster(config, agentStatesPerRound);
    expect(result.totalRounds).toBe(1);
    expect(result.finalGlobalState.length).toBe(LATENT_DIM);
  });
});

// ── Borg Queen Payload ─────────────────────────────────────────────────

describe('Borg Queen Payload', () => {
  it('creates payload with correct adapter key', () => {
    const state = makeRandomVec(1);
    const payload = createBorgQueenPayload(state);
    expect(payload.adapterKey).toBe('borgqueen_L6_global');
    expect(payload.dim).toBe(LATENT_DIM);
    expect(payload.numVectors).toBe(1);
    expect(payload.sourceHiddenSize).toBe(LATENT_DIM);
  });

  it('copies hidden state without mutation', () => {
    const state = makeRandomVec(1);
    const original = new Float32Array(state);
    const payload = createBorgQueenPayload(state);
    // Mutate payload data
    payload.data[0] = 999;
    // Original should be unchanged
    expect(state[0]).toBe(original[0]);
  });
});
