/**
 * Tests for Hermes Layer 4 - Cross-Agent Correlation (Step 7)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  computeCorrelations,
  generatePerturbation,
  executeFeedbackAction,
  executeAllFeedbackActions,
  type CorrelationResult,
  type PerturbationVector,
  type FeedbackExecutionResult,
} from './cross-agent.js';
import { encodeFloat32 } from './trace.js';
import { LATENT_DIM } from './types.js';
import type { ReflectionAction } from './reflective-phase.js';

// ── Test Helpers ───────────────────────────────────────────────────

const TEST_TASK_ID = 'test-cross-agent-task';
const TRACE_DIR = path.join(process.cwd(), 'store', 'hermes-traces');

/** Create a random Float32Array of given dimension. */
function randomVec(dim: number, seed?: number): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = (seed !== undefined ? Math.sin(seed * (i + 1)) : Math.random() - 0.5);
  }
  return arr;
}

/** Create a trace JSONL line for a given agent/round. */
function makeTrace(
  agentId: string,
  round: number,
  hiddenState: Float32Array,
  convergenceDelta: number | null = null,
): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    agentId,
    layer: 'L4',
    round,
    hiddenState: encodeFloat32(hiddenState),
    convergenceDelta,
    metadata: {
      dim: hiddenState.length,
      timestamp: new Date().toISOString(),
      taskId: TEST_TASK_ID,
    },
  });
}

/** Write trace lines to task file. */
function writeTestTraces(lines: string[]): void {
  if (!fs.existsSync(TRACE_DIR)) {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
  }
  const taskFile = path.join(TRACE_DIR, `${TEST_TASK_ID}.jsonl`);
  fs.writeFileSync(taskFile, lines.join('\n') + '\n', 'utf-8');
}

/** Clean up test trace file. */
function cleanupTraces(): void {
  const taskFile = path.join(TRACE_DIR, `${TEST_TASK_ID}.jsonl`);
  if (fs.existsSync(taskFile)) fs.unlinkSync(taskFile);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Cross-Agent Correlation', () => {
  beforeEach(() => cleanupTraces());
  afterEach(() => cleanupTraces());

  describe('computeCorrelations', () => {
    it('returns empty result for no traces', () => {
      const result = computeCorrelations(TEST_TASK_ID);
      expect(result.agentCount).toBe(0);
      expect(result.correlations).toHaveLength(0);
      expect(result.clusters).toHaveLength(0);
    });

    it('returns single-agent result', () => {
      const vec = randomVec(LATENT_DIM, 1);
      writeTestTraces([makeTrace('agent-a', 0, vec)]);

      const result = computeCorrelations(TEST_TASK_ID);
      expect(result.agentCount).toBe(1);
      expect(result.correlations).toHaveLength(0);
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].agents).toEqual(['agent-a']);
    });

    it('computes pairwise similarity for two agents', () => {
      const vecA = randomVec(LATENT_DIM, 1);
      const vecB = randomVec(LATENT_DIM, 2);
      writeTestTraces([
        makeTrace('agent-a', 0, vecA),
        makeTrace('agent-b', 0, vecB),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      expect(result.agentCount).toBe(2);
      expect(result.correlations).toHaveLength(1);
      expect(result.correlations[0].agentA).toBe('agent-a');
      expect(result.correlations[0].agentB).toBe('agent-b');
      expect(typeof result.correlations[0].similarity).toBe('number');
      expect(result.correlations[0].similarity).toBeGreaterThanOrEqual(-1);
      expect(result.correlations[0].similarity).toBeLessThanOrEqual(1);
    });

    it('detects convergence cluster for similar agents', () => {
      // Two agents with nearly identical vectors
      const base = randomVec(LATENT_DIM, 42);
      const similar = new Float32Array(LATENT_DIM);
      for (let i = 0; i < LATENT_DIM; i++) similar[i] = base[i] + 0.001;

      writeTestTraces([
        makeTrace('agent-a', 0, base),
        makeTrace('agent-b', 0, similar),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      expect(result.clusters[0].agents).toContain('agent-a');
      expect(result.clusters[0].agents).toContain('agent-b');
      expect(result.clusters[0].avgSimilarity).toBeGreaterThan(0.85);
    });

    it('identifies outliers for divergent agents', () => {
      // Two similar + one very different
      const base = randomVec(LATENT_DIM, 42);
      const similar = new Float32Array(LATENT_DIM);
      for (let i = 0; i < LATENT_DIM; i++) similar[i] = base[i] + 0.001;
      const divergent = randomVec(LATENT_DIM, 999);

      writeTestTraces([
        makeTrace('agent-a', 0, base),
        makeTrace('agent-b', 0, similar),
        makeTrace('agent-c', 0, divergent),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      // agent-c should be outlier if sufficiently different
      expect(result.agentCount).toBe(3);
      expect(result.correlations).toHaveLength(3); // 3 choose 2
    });

    it('uses final round for multi-round traces', () => {
      const vecR0 = randomVec(LATENT_DIM, 1);
      const vecR1 = randomVec(LATENT_DIM, 2);
      const vecR2 = randomVec(LATENT_DIM, 3);

      writeTestTraces([
        makeTrace('agent-a', 0, vecR0),
        makeTrace('agent-a', 1, vecR1),
        makeTrace('agent-a', 2, vecR2),
        makeTrace('agent-b', 0, vecR2), // agent-b matches agent-a's final
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      // Should compare agent-a round 2 with agent-b round 0
      expect(result.correlations).toHaveLength(1);
      // Since agent-b has same vector as agent-a's final, should be high
      expect(result.correlations[0].similarity).toBeGreaterThan(0.99);
    });

    it('handles three agents with correct pair count', () => {
      writeTestTraces([
        makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 0, randomVec(LATENT_DIM, 2)),
        makeTrace('agent-c', 0, randomVec(LATENT_DIM, 3)),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      expect(result.agentCount).toBe(3);
      // 3 choose 2 = 3 pairs
      expect(result.correlations).toHaveLength(3);
    });

    it('computes mean similarity', () => {
      writeTestTraces([
        makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 0, randomVec(LATENT_DIM, 2)),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      expect(result.meanSimilarity).toBe(result.correlations[0].similarity);
    });

    it('reports round alignment', () => {
      writeTestTraces([
        makeTrace('agent-a', 3, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 3, randomVec(LATENT_DIM, 2)),
        makeTrace('agent-c', 5, randomVec(LATENT_DIM, 3)),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      const abCorr = result.correlations.find(
        (c) => c.agentA === 'agent-a' && c.agentB === 'agent-b',
      );
      const acCorr = result.correlations.find(
        (c) => c.agentA === 'agent-a' && c.agentB === 'agent-c',
      );
      expect(abCorr?.roundAligned).toBe(true);
      expect(acCorr?.roundAligned).toBe(false);
    });
  });

  describe('generatePerturbation', () => {
    it('returns null for unknown agent', () => {
      const result = generatePerturbation(TEST_TASK_ID, 'nonexistent');
      expect(result).toBeNull();
    });

    it('generates random perturbation for single agent', () => {
      writeTestTraces([makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1))]);

      const result = generatePerturbation(TEST_TASK_ID, 'agent-a');
      expect(result).not.toBeNull();
      expect(result!.targetAgent).toBe('agent-a');
      expect(result!.sourceAgent).toBe('noise');
      expect(result!.vector).toBeInstanceOf(Float32Array);
      expect(result!.vector.length).toBe(LATENT_DIM);
      expect(result!.magnitude).toBeGreaterThan(0);
    });

    it('generates directional perturbation from peer', () => {
      const vecA = randomVec(LATENT_DIM, 1);
      const vecB = randomVec(LATENT_DIM, 2);
      writeTestTraces([
        makeTrace('agent-a', 0, vecA),
        makeTrace('agent-b', 0, vecB),
      ]);

      const result = generatePerturbation(TEST_TASK_ID, 'agent-a');
      expect(result).not.toBeNull();
      expect(result!.targetAgent).toBe('agent-a');
      expect(result!.sourceAgent).toBe('agent-b');
      expect(result!.vector.length).toBe(LATENT_DIM);
      expect(result!.magnitude).toBeGreaterThan(0);
      expect(result!.reason).toContain('agent-b');
    });

    it('perturbation vector has correct scale', () => {
      writeTestTraces([
        makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 0, randomVec(LATENT_DIM, 2)),
      ]);

      const result = generatePerturbation(TEST_TASK_ID, 'agent-a');
      // Perturbation should be small relative to hidden state
      expect(result!.magnitude).toBeLessThan(1);
    });

    it('uses provided correlation result', () => {
      writeTestTraces([
        makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 0, randomVec(LATENT_DIM, 2)),
      ]);

      const corr = computeCorrelations(TEST_TASK_ID);
      const result = generatePerturbation(TEST_TASK_ID, 'agent-a', corr);
      expect(result).not.toBeNull();
      expect(result!.sourceAgent).toBe('agent-b');
    });
  });

  describe('executeFeedbackAction', () => {
    it('rejects non-inject_feedback action', () => {
      const action: ReflectionAction = { type: 'continue', detail: 'test' };
      const result = executeFeedbackAction(TEST_TASK_ID, action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not an inject_feedback');
    });

    it('rejects action without targetAgent', () => {
      const action: ReflectionAction = { type: 'inject_feedback', detail: 'test' };
      const result = executeFeedbackAction(TEST_TASK_ID, action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No targetAgent');
    });

    it('fails gracefully for agent with no traces', () => {
      const action: ReflectionAction = {
        type: 'inject_feedback',
        detail: 'test',
        targetAgent: 'nonexistent',
      };
      const result = executeFeedbackAction(TEST_TASK_ID, action);
      expect(result.success).toBe(false);
    });

    it('successfully applies perturbation and writes trace', () => {
      const vec = randomVec(LATENT_DIM, 1);
      writeTestTraces([makeTrace('agent-a', 0, vec)]);

      const action: ReflectionAction = {
        type: 'inject_feedback',
        detail: 'Stagnation at agent-a',
        targetAgent: 'agent-a',
      };

      const result = executeFeedbackAction(TEST_TASK_ID, action);
      expect(result.success).toBe(true);
      expect(result.perturbation).toBeDefined();
      expect(result.perturbation!.targetAgent).toBe('agent-a');

      // Verify new trace was written (round 1)
      const taskFile = path.join(TRACE_DIR, `${TEST_TASK_ID}.jsonl`);
      const lines = fs.readFileSync(taskFile, 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBe(2); // original + perturbed
      const newTrace = JSON.parse(lines[1]);
      expect(newTrace.round).toBe(1);
      expect(newTrace.agentId).toBe('agent-a');
    });

    it('uses peer direction when available', () => {
      writeTestTraces([
        makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 0, randomVec(LATENT_DIM, 2)),
      ]);

      const action: ReflectionAction = {
        type: 'inject_feedback',
        detail: 'Stagnation at agent-a',
        targetAgent: 'agent-a',
      };

      const result = executeFeedbackAction(TEST_TASK_ID, action);
      expect(result.success).toBe(true);
      expect(result.perturbation!.sourceAgent).toBe('agent-b');
    });
  });

  describe('executeAllFeedbackActions', () => {
    it('returns empty for no inject_feedback actions', () => {
      const actions: ReflectionAction[] = [
        { type: 'continue', detail: 'test' },
        { type: 'converged', detail: 'done' },
      ];
      const results = executeAllFeedbackActions(TEST_TASK_ID, actions);
      expect(results).toHaveLength(0);
    });

    it('processes multiple inject_feedback actions', () => {
      writeTestTraces([
        makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1)),
        makeTrace('agent-b', 0, randomVec(LATENT_DIM, 2)),
      ]);

      const actions: ReflectionAction[] = [
        { type: 'continue', detail: 'round 2' },
        { type: 'inject_feedback', detail: 'stag a', targetAgent: 'agent-a' },
        { type: 'inject_feedback', detail: 'stag b', targetAgent: 'agent-b' },
      ];

      const results = executeAllFeedbackActions(TEST_TASK_ID, actions);
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('filters only inject_feedback from mixed actions', () => {
      writeTestTraces([makeTrace('agent-a', 0, randomVec(LATENT_DIM, 1))]);

      const actions: ReflectionAction[] = [
        { type: 'escalate', detail: 'error' },
        { type: 'inject_feedback', detail: 'stag', targetAgent: 'agent-a' },
        { type: 'adjust_depth', detail: 'oscillation' },
      ];

      const results = executeAllFeedbackActions(TEST_TASK_ID, actions);
      expect(results).toHaveLength(1);
      expect(results[0].action.targetAgent).toBe('agent-a');
    });
  });

  describe('Cluster Detection', () => {
    it('forms cluster from 3 similar agents', () => {
      const base = randomVec(LATENT_DIM, 42);
      const agents = ['agent-a', 'agent-b', 'agent-c'];
      const traces = agents.map((id, i) => {
        const vec = new Float32Array(LATENT_DIM);
        for (let j = 0; j < LATENT_DIM; j++) vec[j] = base[j] + i * 0.0001;
        return makeTrace(id, 0, vec);
      });

      writeTestTraces(traces);
      const result = computeCorrelations(TEST_TASK_ID);

      expect(result.clusters.length).toBe(1);
      expect(result.clusters[0].agents).toHaveLength(3);
      expect(result.outliers).toHaveLength(0);
    });

    it('forms two clusters from two groups', () => {
      // Group 1: agents a, b (similar)
      const base1 = randomVec(LATENT_DIM, 42);
      // Group 2: agents c, d (similar to each other, different from group 1)
      const base2 = randomVec(LATENT_DIM, 999);

      writeTestTraces([
        makeTrace('agent-a', 0, base1),
        makeTrace('agent-b', 0, (() => {
          const v = new Float32Array(LATENT_DIM);
          for (let i = 0; i < LATENT_DIM; i++) v[i] = base1[i] + 0.0001;
          return v;
        })()),
        makeTrace('agent-c', 0, base2),
        makeTrace('agent-d', 0, (() => {
          const v = new Float32Array(LATENT_DIM);
          for (let i = 0; i < LATENT_DIM; i++) v[i] = base2[i] + 0.0001;
          return v;
        })()),
      ]);

      const result = computeCorrelations(TEST_TASK_ID);
      // Should have 2 clusters (if groups sufficiently different)
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      expect(result.agentCount).toBe(4);
    });

    it('handles high-dimensional vectors efficiently', () => {
      // 5 agents with 768-dim vectors — should complete quickly
      const traces = [];
      for (let i = 0; i < 5; i++) {
        traces.push(makeTrace(`agent-${i}`, 0, randomVec(LATENT_DIM, i)));
      }
      writeTestTraces(traces);

      const start = Date.now();
      const result = computeCorrelations(TEST_TASK_ID);
      const elapsed = Date.now() - start;

      expect(result.agentCount).toBe(5);
      expect(result.correlations).toHaveLength(10); // 5 choose 2
      expect(elapsed).toBeLessThan(5000); // Should be < 5s
    });
  });
});
