/**
 * Hermes Layer 4 - Depth Mapping Tests (Step 5)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  classifyTask,
  autoReflect,
  batchClassify,
  writeTrace,
  clearRegistry,
  LATENT_DIM,
} from './index.js';

import type { TaskSignals, TaskClassification, AutoReflectionResult } from './index.js';

// ── Helpers ─────────────────────────────────────────────────────────

function cleanTraces(taskId: string): void {
  const traceDir = path.join(process.cwd(), 'store', 'hermes-traces');
  const file = path.join(traceDir, `${taskId}.jsonl`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function cleanSkill(taskId: string): void {
  const skillDir = path.join(process.cwd(), 'store', 'hermes-skills');
  const file = path.join(skillDir, `${taskId}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function writeTestTrace(taskId: string, agentId: string, round: number, delta: number | null): void {
  const vec = new Float32Array(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    vec[i] = Math.sin(i * 0.01 + round * 0.5) * 0.1;
  }
  writeTrace({
    agentId,
    layer: 'L4',
    round,
    hiddenState: vec,
    convergenceDelta: delta,
    metadata: {
      dim: LATENT_DIM,
      timestamp: new Date().toISOString(),
      taskId,
    },
  });
}

// ── classifyTask Tests ──────────────────────────────────────────────

describe('classifyTask', () => {
  it('returns light for generic task', () => {
    const result = classifyTask({
      agentId: 'content',
      prompt: 'Write a blog post about cats',
    });
    expect(result.inferredDepth).toBe('light');
    expect(result.isSecurityAdjacent).toBe(false);
    expect(result.isHighRisk).toBe(false);
  });

  it('detects security-adjacent agent', () => {
    const result = classifyTask({
      agentId: 'deepsec',
      prompt: 'Scan the codebase',
    });
    expect(result.isSecurityAdjacent).toBe(true);
    expect(result.inferredDepth).toBe('deep');
    expect(result.reason).toContain('security-agent');
  });

  it('detects security keywords in prompt', () => {
    const result = classifyTask({
      agentId: 'ops',
      prompt: 'Check authentication flow and validate CSRF tokens',
    });
    expect(result.isSecurityAdjacent).toBe(true);
    expect(result.inferredDepth).toBe('deep');
    expect(result.reason).toContain('security-keywords');
  });

  it('detects high-risk keywords', () => {
    const result = classifyTask({
      agentId: 'ops',
      prompt: 'Run database migration on production',
    });
    expect(result.isHighRisk).toBe(true);
    expect(result.inferredDepth).toBe('deep');
    expect(result.reason).toContain('high-risk');
  });

  it('maps agent ID to layer', () => {
    const result = classifyTask({
      agentId: 'borg-arc',
      prompt: 'Analyze repository structure',
    });
    expect(result.layer).toBe('L3');
    expect(result.inferredDepth).toBe('standard');
  });

  it('explicit layer overrides agent detection', () => {
    const result = classifyTask({
      agentId: 'content',
      prompt: 'Write something',
      layer: 'L2',
    });
    expect(result.layer).toBe('L2');
    expect(result.inferredDepth).toBe('standard');
  });

  it('explicit depth wins over everything', () => {
    const result = classifyTask({
      agentId: 'deepsec',
      prompt: 'Check authentication with CSRF on production database migration',
      explicitDepth: 'light',
    });
    expect(result.inferredDepth).toBe('light');
    expect(result.reason).toContain('explicit=light');
  });

  it('combines multiple signals in reason', () => {
    const result = classifyTask({
      agentId: 'security',
      prompt: 'Deploy authentication changes to production',
    });
    expect(result.reason).toContain('security-agent');
    expect(result.reason).toContain('security-keywords');
    expect(result.reason).toContain('high-risk');
  });
});

// ── autoReflect Tests ───────────────────────────────────────────────

describe('autoReflect', () => {
  const taskId = 'test-auto-reflect-' + Date.now();

  beforeEach(() => {
    cleanTraces(taskId);
    cleanSkill(taskId);
    clearRegistry();
  });

  it('triggers reflection for any task by default', () => {
    writeTestTrace(taskId, 'planner', 0, null);
    writeTestTrace(taskId, 'planner', 1, 0.3);

    const result = autoReflect({
      taskId,
      agentId: 'content',
      prompt: 'Write a blog post',
    });

    expect(result.triggered).toBe(true);
    expect(result.reflection).toBeDefined();
    expect(result.classification.inferredDepth).toBe('light');
  });

  it('writes skill file by default', () => {
    writeTestTrace(taskId, 'planner', 0, null);

    const result = autoReflect({
      taskId,
      agentId: 'ops',
      prompt: 'Simple task',
    });

    expect(result.skillFile).toBeDefined();
    expect(result.skillFile!.taskId).toBe(taskId);
    cleanSkill(taskId);
  });

  it('skips skill file when writeSkill=false', () => {
    writeTestTrace(taskId, 'planner', 0, null);

    const result = autoReflect({
      taskId,
      agentId: 'ops',
      prompt: 'Simple task',
      writeSkill: false,
    });

    expect(result.triggered).toBe(true);
    expect(result.skillFile).toBeUndefined();
  });

  it('skips reflection when below threshold', () => {
    const result = autoReflect({
      taskId,
      agentId: 'content',
      prompt: 'Write a blog post',
      minDepthToTrigger: 'standard',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('below threshold');
    expect(result.reflection).toBeUndefined();
  });

  it('triggers deep reflection for security tasks', () => {
    writeTestTrace(taskId, 'deepsec', 0, null);
    writeTestTrace(taskId, 'deepsec', 1, 0.1);

    const result = autoReflect({
      taskId,
      agentId: 'deepsec',
      prompt: 'Scan for vulnerabilities',
    });

    expect(result.triggered).toBe(true);
    expect(result.classification.inferredDepth).toBe('deep');
    expect(result.classification.isSecurityAdjacent).toBe(true);
    cleanSkill(taskId);
  });

  it('respects explicit depth override', () => {
    writeTestTrace(taskId, 'planner', 0, null);

    const result = autoReflect({
      taskId,
      agentId: 'content',
      prompt: 'Simple task',
      explicitDepth: 'deep',
    });

    expect(result.classification.inferredDepth).toBe('deep');
    expect(result.reflection!.depth).toBe('deep');
    cleanSkill(taskId);
  });
});

// ── batchClassify Tests ─────────────────────────────────────────────

describe('batchClassify', () => {
  it('classifies multiple tasks', () => {
    const results = batchClassify([
      { taskId: 't1', agentId: 'content', prompt: 'Write stuff' },
      { taskId: 't2', agentId: 'deepsec', prompt: 'Scan code' },
      { taskId: 't3', agentId: 'ops', prompt: 'Deploy to production' },
    ]);

    expect(results.size).toBe(3);
    expect(results.get('t1')!.inferredDepth).toBe('light');
    expect(results.get('t2')!.inferredDepth).toBe('deep');
    expect(results.get('t3')!.inferredDepth).toBe('deep');
  });

  it('returns empty map for empty input', () => {
    const results = batchClassify([]);
    expect(results.size).toBe(0);
  });
});
