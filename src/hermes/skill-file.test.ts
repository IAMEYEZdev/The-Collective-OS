/**
 * Hermes Layer 4 - Skill File Writer Tests (Step 4)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  writeSkillFile,
  readSkillFile,
  readSkillFileText,
  readSkillFileLatent,
  listSkillFiles,
  deleteSkillFile,
  findSkillFiles,
  skillFileSimilarity,
  LATENT_DIM,
  encodeFloat32,
} from './index.js';

import type { LatentSkillFile, SkillFileReadResult } from './index.js';
import type { ReflectionSkillSummary } from './reflective-phase.js';

// ── Helpers ─────────────────────────────────────────────────────────

const SKILL_DIR = path.join(process.cwd(), 'store', 'hermes-skills');

function makeSummary(overrides?: Partial<ReflectionSkillSummary>): ReflectionSkillSummary {
  const vec = new Float32Array(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    vec[i] = Math.sin(i * 0.01) * 0.1;
  }
  return {
    taskId: 'test-skill-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    reflectorAgentId: 'reflector-test',
    depth: 'light',
    roundsExecuted: 2,
    converged: true,
    finalDelta: 0.008,
    anomalyCount: 0,
    anomalyTypes: [],
    actionTypes: [],
    meanHiddenState: vec,
    ...overrides,
  };
}

function cleanSkillFile(taskId: string): void {
  const file = path.join(SKILL_DIR, `${taskId}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── Write Tests ─────────────────────────────────────────────────────

describe('writeSkillFile', () => {
  it('creates a valid JSON skill file', () => {
    const summary = makeSummary();
    const file = writeSkillFile({ summary });

    expect(file.version).toBe(1);
    expect(file.taskId).toBe(summary.taskId);
    expect(file.reflectorAgentId).toBe('reflector-test');
    expect(file.latentEncoding).toBe('float32-base64');
    expect(file.latentDim).toBe(LATENT_DIM);
    expect(file.latentState).toBeTruthy();
    expect(file.textSummary).toContain(summary.taskId);

    cleanSkillFile(summary.taskId);
  });

  it('uses custom textSummary when provided', () => {
    const summary = makeSummary();
    const file = writeSkillFile({
      summary,
      textSummary: 'Custom summary text',
    });

    expect(file.textSummary).toBe('Custom summary text');
    cleanSkillFile(summary.taskId);
  });

  it('preserves ID on update', () => {
    const summary = makeSummary();
    const first = writeSkillFile({ summary });
    const second = writeSkillFile({ summary });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);

    cleanSkillFile(summary.taskId);
  });

  it('includes anomaly and action info', () => {
    const summary = makeSummary({
      anomalyCount: 2,
      anomalyTypes: ['divergence', 'oscillation'],
      actionTypes: ['extend_rounds', 'flag_for_review'],
      converged: false,
      finalDelta: 0.15,
    });
    const file = writeSkillFile({ summary });

    expect(file.anomalyCount).toBe(2);
    expect(file.anomalyTypes).toEqual(['divergence', 'oscillation']);
    expect(file.actionTypes).toEqual(['extend_rounds', 'flag_for_review']);
    expect(file.converged).toBe(false);
    expect(file.textSummary).toContain('Did not converge');
    expect(file.textSummary).toContain('2 anomalies');

    cleanSkillFile(summary.taskId);
  });

  it('writes actual file to disk', () => {
    const summary = makeSummary();
    writeSkillFile({ summary });

    const filePath = path.join(SKILL_DIR, `${summary.taskId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.latentState).toBeTruthy();

    cleanSkillFile(summary.taskId);
  });
});

// ── Read Tests ──────────────────────────────────────────────────────

describe('readSkillFile', () => {
  it('returns null for nonexistent task', () => {
    expect(readSkillFile('nonexistent-task-xyz')).toBeNull();
  });

  it('reads back written file with decoded vector', () => {
    const summary = makeSummary();
    writeSkillFile({ summary });

    const result = readSkillFile(summary.taskId);
    expect(result).not.toBeNull();
    expect(result!.file.taskId).toBe(summary.taskId);
    expect(result!.meanHiddenState).toBeInstanceOf(Float32Array);
    expect(result!.meanHiddenState.length).toBe(LATENT_DIM);

    // Verify vector values round-trip correctly
    for (let i = 0; i < 10; i++) {
      expect(result!.meanHiddenState[i]).toBeCloseTo(summary.meanHiddenState[i], 5);
    }

    cleanSkillFile(summary.taskId);
  });
});

describe('readSkillFileText', () => {
  it('returns text summary only', () => {
    const summary = makeSummary();
    writeSkillFile({ summary, textSummary: 'Just the text' });

    expect(readSkillFileText(summary.taskId)).toBe('Just the text');
    expect(readSkillFileText('nonexistent')).toBeNull();

    cleanSkillFile(summary.taskId);
  });
});

describe('readSkillFileLatent', () => {
  it('returns decoded vector only', () => {
    const summary = makeSummary();
    writeSkillFile({ summary });

    const vec = readSkillFileLatent(summary.taskId);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(LATENT_DIM);
    expect(readSkillFileLatent('nonexistent')).toBeNull();

    cleanSkillFile(summary.taskId);
  });
});

// ── List / Delete Tests ─────────────────────────────────────────────

describe('listSkillFiles', () => {
  it('lists written skill files', () => {
    const s1 = makeSummary({ taskId: 'list-test-a-' + Date.now() });
    const s2 = makeSummary({ taskId: 'list-test-b-' + Date.now() });
    writeSkillFile({ summary: s1 });
    writeSkillFile({ summary: s2 });

    const list = listSkillFiles();
    expect(list).toContain(s1.taskId);
    expect(list).toContain(s2.taskId);

    cleanSkillFile(s1.taskId);
    cleanSkillFile(s2.taskId);
  });
});

describe('deleteSkillFile', () => {
  it('deletes existing file', () => {
    const summary = makeSummary();
    writeSkillFile({ summary });
    expect(deleteSkillFile(summary.taskId)).toBe(true);
    expect(readSkillFile(summary.taskId)).toBeNull();
  });

  it('returns false for nonexistent', () => {
    expect(deleteSkillFile('nonexistent-delete-xyz')).toBe(false);
  });
});

// ── Find Tests ──────────────────────────────────────────────────────

describe('findSkillFiles', () => {
  it('filters by predicate', () => {
    const s1 = makeSummary({ anomalyCount: 3, anomalyTypes: ['divergence'] });
    const s2 = makeSummary({ anomalyCount: 0 });
    writeSkillFile({ summary: s1 });
    writeSkillFile({ summary: s2 });

    const withAnomalies = findSkillFiles((f) => f.anomalyCount > 0);
    const ids = withAnomalies.map((f) => f.taskId);
    expect(ids).toContain(s1.taskId);
    expect(ids).not.toContain(s2.taskId);

    cleanSkillFile(s1.taskId);
    cleanSkillFile(s2.taskId);
  });
});

// ── Similarity Tests ────────────────────────────────────────────────

describe('skillFileSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const vec = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) vec[i] = Math.sin(i * 0.01);

    const s1 = makeSummary({ taskId: 'sim-a-' + Date.now(), meanHiddenState: vec });
    const s2 = makeSummary({ taskId: 'sim-b-' + Date.now(), meanHiddenState: new Float32Array(vec) });
    writeSkillFile({ summary: s1 });
    writeSkillFile({ summary: s2 });

    const sim = skillFileSimilarity(s1.taskId, s2.taskId);
    expect(sim).toBeCloseTo(1.0, 4);

    cleanSkillFile(s1.taskId);
    cleanSkillFile(s2.taskId);
  });

  it('returns lower similarity for different vectors', () => {
    const vecA = new Float32Array(LATENT_DIM);
    const vecB = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) {
      vecA[i] = Math.sin(i * 0.01);
      vecB[i] = Math.cos(i * 0.5); // very different pattern
    }

    const s1 = makeSummary({ taskId: 'sim-diff-a-' + Date.now(), meanHiddenState: vecA });
    const s2 = makeSummary({ taskId: 'sim-diff-b-' + Date.now(), meanHiddenState: vecB });
    writeSkillFile({ summary: s1 });
    writeSkillFile({ summary: s2 });

    const sim = skillFileSimilarity(s1.taskId, s2.taskId);
    expect(sim).not.toBeNull();
    expect(sim!).toBeLessThan(0.9);

    cleanSkillFile(s1.taskId);
    cleanSkillFile(s2.taskId);
  });

  it('returns null for missing files', () => {
    expect(skillFileSimilarity('nonexistent-a', 'nonexistent-b')).toBeNull();
  });
});
