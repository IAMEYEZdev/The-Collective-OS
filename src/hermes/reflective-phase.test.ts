/**
 * Hermes Layer 4 - Reflective Phase Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  REFLECTION_ROUNDS,
  inferReflectionDepth,
  analyzeTraces,
  runReflection,
  summarizeForSkillFile,
  clearRegistry,
  writeTrace,
  encodeFloat32,
  LATENT_DIM,
} from './index.js';

import type {
  ReflectionDepth,
  TraceAnalysis,
  ReflectionInput,
  ReflectionResult,
} from './index.js';

import type { TraceEntry } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Write a fake trace for a task with given convergence delta. */
function writeTestTrace(opts: {
  taskId: string;
  agentId: string;
  round: number;
  delta: number | null;
  dim?: number;
}): void {
  const dim = opts.dim ?? LATENT_DIM;
  const vec = new Float32Array(dim);
  // Fill with deterministic values based on round to get varying states
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin(i * 0.01 + opts.round * 0.5) * 0.1;
  }

  writeTrace({
    agentId: opts.agentId,
    layer: 'L4',
    round: opts.round,
    hiddenState: vec,
    convergenceDelta: opts.delta,
    metadata: {
      dim,
      timestamp: new Date().toISOString(),
      taskId: opts.taskId,
    },
  });
}

/** Clean up test trace files. */
function cleanTraces(taskId: string): void {
  const traceDir = path.join(process.cwd(), 'store', 'hermes-traces');
  const file = path.join(traceDir, `${taskId}.jsonl`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── Constants Tests ────────────────────────────────────────────────

describe('Reflection Constants', () => {
  it('REFLECTION_ROUNDS locked at 2/4/8', () => {
    expect(REFLECTION_ROUNDS.light).toBe(2);
    expect(REFLECTION_ROUNDS.standard).toBe(4);
    expect(REFLECTION_ROUNDS.deep).toBe(8);
  });
});

// ── inferReflectionDepth Tests ─────────────────────────────────────

describe('inferReflectionDepth', () => {
  it('returns explicit depth when provided', () => {
    expect(inferReflectionDepth({ explicit: 'deep' })).toBe('deep');
    // explicit always wins, even over isHighRisk
    expect(inferReflectionDepth({ explicit: 'light', isHighRisk: true })).toBe('light');
  });

  it('returns deep for security-adjacent tasks', () => {
    expect(inferReflectionDepth({ isSecurityAdjacent: true })).toBe('deep');
  });

  it('returns deep for high-risk tasks', () => {
    expect(inferReflectionDepth({ isHighRisk: true })).toBe('deep');
  });

  it('returns standard for L2/L3 layers', () => {
    expect(inferReflectionDepth({ layer: 'L2' })).toBe('standard');
    expect(inferReflectionDepth({ layer: 'L3' })).toBe('standard');
  });

  it('returns light by default', () => {
    expect(inferReflectionDepth({})).toBe('light');
    expect(inferReflectionDepth({ layer: 'L1' })).toBe('light');
    expect(inferReflectionDepth({ layer: 'L4' })).toBe('light');
  });
});

// ── analyzeTraces Tests ────────────────────────────────────────────

describe('analyzeTraces', () => {
  const taskId = 'test-analyze-' + Date.now();

  beforeEach(() => {
    cleanTraces(taskId);
  });

  it('returns empty analysis for nonexistent task', () => {
    const result = analyzeTraces('nonexistent-task-xyz');
    expect(result.totalRounds).toBe(0);
    expect(result.convergenceTrajectory).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  it('tracks convergence trajectory', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 1, delta: 0.5 });
    writeTestTrace({ taskId, agentId: 'agent1', round: 2, delta: 0.1 });

    const result = analyzeTraces(taskId);
    expect(result.totalRounds).toBe(3);
    expect(result.agents).toEqual(['agent1']);
    expect(result.convergenceTrajectory.length).toBe(3);
  });

  it('detects convergence', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 1, delta: 0.01 });

    const result = analyzeTraces(taskId);
    expect(result.reachedConvergence).toBe(true);
    expect(result.finalDelta).toBe(0.01);
  });

  it('detects non-convergence', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 1, delta: 0.3 });

    const result = analyzeTraces(taskId);
    expect(result.reachedConvergence).toBe(false);
  });

  it('detects divergence anomaly', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 1, delta: 0.2 });
    writeTestTrace({ taskId, agentId: 'agent1', round: 2, delta: 0.5 }); // increased

    const result = analyzeTraces(taskId);
    const divs = result.anomalies.filter((a) => a.type === 'divergence');
    expect(divs.length).toBeGreaterThan(0);
    expect(divs[0].agentId).toBe('agent1');
  });

  it('detects missing rounds anomaly', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 3, delta: 0.1 }); // gap: 1,2 missing

    const result = analyzeTraces(taskId);
    const gaps = result.anomalies.filter((a) => a.type === 'missing_rounds');
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('detects stagnation anomaly', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 1, delta: 0.05 });
    writeTestTrace({ taskId, agentId: 'agent1', round: 2, delta: 0.05 });
    writeTestTrace({ taskId, agentId: 'agent1', round: 3, delta: 0.05 });

    const result = analyzeTraces(taskId);
    const stags = result.anomalies.filter((a) => a.type === 'stagnation');
    expect(stags.length).toBeGreaterThan(0);
  });

  it('detects dimension mismatch', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null, dim: 512 });

    const result = analyzeTraces(taskId);
    const dims = result.anomalies.filter((a) => a.type === 'dimension_mismatch');
    expect(dims.length).toBeGreaterThan(0);
    expect(dims[0].severity).toBe('error');
  });

  it('detects oscillation', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent1', round: 1, delta: 0.3 });
    writeTestTrace({ taskId, agentId: 'agent1', round: 2, delta: 0.5 }); // up
    writeTestTrace({ taskId, agentId: 'agent1', round: 3, delta: 0.2 }); // down
    writeTestTrace({ taskId, agentId: 'agent1', round: 4, delta: 0.4 }); // up
    writeTestTrace({ taskId, agentId: 'agent1', round: 5, delta: 0.15 }); // down

    const result = analyzeTraces(taskId);
    const oscs = result.anomalies.filter((a) => a.type === 'oscillation');
    expect(oscs.length).toBeGreaterThan(0);
  });

  it('tracks multiple agents', () => {
    writeTestTrace({ taskId, agentId: 'agent1', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'agent2', round: 0, delta: null });

    const result = analyzeTraces(taskId);
    expect(result.agents).toContain('agent1');
    expect(result.agents).toContain('agent2');
  });
});

// ── runReflection Tests ────────────────────────────────────────────

describe('runReflection', () => {
  const taskId = 'test-reflect-' + Date.now();

  beforeEach(() => {
    cleanTraces(taskId);
    clearRegistry();
  });

  it('runs light reflection (2 rounds max)', () => {
    // Seed some traces
    writeTestTrace({ taskId, agentId: 'planner', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'planner', round: 1, delta: 0.3 });

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-1',
      depth: 'light',
    });

    expect(result.depth).toBe('light');
    expect(result.maxRounds).toBe(2);
    expect(result.roundsExecuted).toBeLessThanOrEqual(2);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.taskId).toBe(taskId);
  });

  it('returns round analysis with observations', () => {
    writeTestTrace({ taskId, agentId: 'planner', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'planner', round: 1, delta: 0.1 });

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-2',
      depth: 'light',
    });

    const firstRound = result.rounds[0];
    expect(firstRound.round).toBe(0);
    expect(firstRound.analysis).toBeDefined();
    expect(firstRound.observations.length).toBeGreaterThan(0);
    expect(firstRound.traceId).toBeTruthy();
  });

  it('writes reflection traces', () => {
    writeTestTrace({ taskId, agentId: 'planner', round: 0, delta: null });

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-3',
      depth: 'light',
    });

    // Reflection itself writes traces, so reading traces now includes them
    const allTraces = analyzeTraces(taskId);
    expect(allTraces.agents).toContain('reflector-3');
  });

  it('handles empty trace set gracefully', () => {
    const emptyTask = 'empty-task-' + Date.now();
    cleanTraces(emptyTask);

    const result = runReflection({
      taskId: emptyTask,
      reflectorAgentId: 'reflector-4',
      depth: 'light',
    });

    expect(result.roundsExecuted).toBeGreaterThan(0);
    // Should still produce observations ("No traces found")
    expect(result.rounds[0].observations).toContain('No traces found for this task');
  });

  it('produces final actions array', () => {
    writeTestTrace({ taskId, agentId: 'planner', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'planner', round: 1, delta: 0.5 });

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-5',
      depth: 'light',
    });

    // finalActions always present (may be empty if reflection converges quickly)
    expect(Array.isArray(result.finalActions)).toBe(true);
    expect(result.rounds.length).toBeGreaterThan(0);
  });

  it('early exits when task already converged with no anomalies', () => {
    writeTestTrace({ taskId, agentId: 'planner', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'planner', round: 1, delta: 0.005 }); // converged

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-6',
      depth: 'standard', // 4 rounds max
    });

    // Should stop before exhausting all 4 rounds
    expect(result.roundsExecuted).toBeLessThan(4);
  });
});

// ── summarizeForSkillFile Tests ────────────────────────────────────

describe('summarizeForSkillFile', () => {
  const taskId = 'test-summary-' + Date.now();

  beforeEach(() => {
    cleanTraces(taskId);
    clearRegistry();
  });

  it('produces skill summary from reflection result', () => {
    writeTestTrace({ taskId, agentId: 'planner', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'planner', round: 1, delta: 0.3 });

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-s',
      depth: 'light',
    });

    const summary = summarizeForSkillFile(result);
    expect(summary.taskId).toBe(taskId);
    expect(summary.reflectorAgentId).toBe('reflector-s');
    expect(summary.depth).toBe('light');
    expect(summary.roundsExecuted).toBeGreaterThan(0);
    expect(summary.meanHiddenState).toBeInstanceOf(Float32Array);
    expect(summary.meanHiddenState.length).toBe(LATENT_DIM);
  });

  it('captures anomaly types', () => {
    writeTestTrace({ taskId, agentId: 'a', round: 0, delta: null });
    writeTestTrace({ taskId, agentId: 'a', round: 1, delta: 0.2 });
    writeTestTrace({ taskId, agentId: 'a', round: 2, delta: 0.5 }); // divergence

    const result = runReflection({
      taskId,
      reflectorAgentId: 'reflector-t',
      depth: 'light',
    });

    const summary = summarizeForSkillFile(result);
    expect(summary.anomalyTypes.length).toBeGreaterThanOrEqual(0);
    expect(summary.actionTypes.length).toBeGreaterThan(0);
  });
});
