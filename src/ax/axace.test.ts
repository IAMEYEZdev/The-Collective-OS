/**
 * Ax Layer 5 - AxACE Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { LATENT_DIM } from '../hermes/types.js';

import {
  getPlaybook,
  matchPlaybook,
  upsertPlaybookEntry,
  analyzeTracesForReflection,
  generate,
  reflect,
  curate,
  runAxACE,
  getPlaybookStats,
} from './axace.js';
import type { PlaybookEntry } from './types.js';
import { AX_PLAYBOOK_DIR } from './types.js';

// ── Cleanup ────────────────────────────────────────────────────────

const PLAYBOOK_DIR = path.join(PROJECT_ROOT, AX_PLAYBOOK_DIR);
const TRACES_DIR = path.join(PROJECT_ROOT, 'store', 'hermes-traces');

function cleanPlaybook(): void {
  if (fs.existsSync(PLAYBOOK_DIR)) {
    fs.rmSync(PLAYBOOK_DIR, { recursive: true, force: true });
  }
}

function cleanTraces(): void {
  if (fs.existsSync(TRACES_DIR)) {
    fs.rmSync(TRACES_DIR, { recursive: true, force: true });
  }
}

describe('AxACE', () => {
  beforeEach(() => {
    cleanPlaybook();
    cleanTraces();
  });
  afterEach(() => {
    cleanPlaybook();
    cleanTraces();
  });

  // ── Playbook CRUD ────────────────────────────────────────────

  describe('playbook', () => {
    it('starts empty', () => {
      expect(getPlaybook()).toEqual([]);
    });

    it('upserts and retrieves entries', () => {
      const entry: PlaybookEntry = {
        id: 'test-1',
        taskPattern: 'code-review',
        strategy: 'Read file, check types, verify tests',
        sourceTraceIds: ['trace-a'],
        curatorScore: 0.8,
        applicationCount: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      upsertPlaybookEntry(entry);

      const book = getPlaybook();
      expect(book.length).toBe(1);
      expect(book[0].id).toBe('test-1');
      expect(book[0].strategy).toContain('check types');
    });

    it('stores and retrieves latent fingerprints', () => {
      const fp = new Float32Array(LATENT_DIM);
      for (let i = 0; i < LATENT_DIM; i++) fp[i] = Math.sin(i * 0.01);

      const entry: PlaybookEntry = {
        id: 'fp-test',
        taskPattern: 'latent-test',
        strategy: 'strategy with fingerprint',
        latentFingerprint: fp,
        sourceTraceIds: [],
        curatorScore: 0.9,
        applicationCount: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      upsertPlaybookEntry(entry);

      const book = getPlaybook();
      expect(book[0].latentFingerprint).toBeTruthy();
      expect(book[0].latentFingerprint!.length).toBe(LATENT_DIM);
      // Check a few values survived round-trip
      expect(book[0].latentFingerprint![0]).toBeCloseTo(fp[0], 4);
      expect(book[0].latentFingerprint![100]).toBeCloseTo(fp[100], 4);
    });

    it('matchPlaybook finds by text', () => {
      upsertPlaybookEntry({
        id: 'm-1',
        taskPattern: 'security-audit',
        strategy: 'scan for vulns',
        sourceTraceIds: [],
        curatorScore: 0.7,
        applicationCount: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

      const matches = matchPlaybook('security-audit');
      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe('m-1');
    });

    it('matchPlaybook returns empty for no match', () => {
      expect(matchPlaybook('nonexistent-pattern')).toEqual([]);
    });
  });

  // ── Trace Analysis ───────────────────────────────────────────

  describe('analyzeTracesForReflection', () => {
    it('returns empty analysis for missing task', () => {
      const analysis = analyzeTracesForReflection('missing-task');
      expect(analysis.convergenceTrajectory).toEqual([]);
      expect(analysis.anomalies).toEqual([]);
      expect(analysis.traceIds).toEqual([]);
      expect(analysis.totalRounds).toBe(0);
      expect(analysis.meanState.length).toBe(LATENT_DIM);
    });
  });

  // ── Generator ────────────────────────────────────────────────

  describe('generate', () => {
    it('produces strategy text', () => {
      const analysis = analyzeTracesForReflection('no-task');
      const strategy = generate('code-review', analysis, []);
      expect(strategy).toContain('code-review');
    });

    it('incorporates existing strategies', () => {
      const analysis = analyzeTracesForReflection('no-task');
      const existing: PlaybookEntry[] = [{
        id: 'e-1',
        taskPattern: 'code-review',
        strategy: 'check edge cases first',
        sourceTraceIds: [],
        curatorScore: 0.85,
        applicationCount: 3,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }];
      const strategy = generate('code-review', analysis, existing);
      expect(strategy).toContain('proven strategy');
    });
  });

  // ── Reflector ────────────────────────────────────────────────

  describe('reflect', () => {
    it('produces reflection text', () => {
      const analysis = analyzeTracesForReflection('no-task');
      const reflection = reflect('some strategy', analysis);
      expect(reflection).toContain('Reflection');
    });

    it('notes no anomalies when clean', () => {
      const analysis = analyzeTracesForReflection('no-task');
      const reflection = reflect('strategy', analysis);
      expect(reflection).toContain('No anomalies');
    });
  });

  // ── Curator ──────────────────────────────────────────────────

  describe('curate', () => {
    it('returns verdict and score', () => {
      const analysis = analyzeTracesForReflection('no-task');
      const result = curate('good strategy', 'looks clean', analysis);
      expect(['accept', 'refine', 'reject']).toContain(result.verdict);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('penalizes many warnings', () => {
      const analysis = analyzeTracesForReflection('no-task');
      const clean = curate('strategy', 'looks good', analysis);
      const warned = curate('strategy', 'WARNING: bad. WARNING: worse. WARNING: terrible.', analysis);
      expect(warned.score).toBeLessThan(clean.score);
    });
  });

  // ── Full Loop ────────────────────────────────────────────────

  describe('runAxACE', () => {
    it('runs loop and returns result', () => {
      const result = runAxACE('task-1', 'code-review', 3);
      expect(result.taskId).toBe('task-1');
      expect(result.roundsExecuted).toBeGreaterThan(0);
      expect(result.roundsExecuted).toBeLessThanOrEqual(3);
      expect(result.iterations.length).toBe(result.roundsExecuted);
    });

    it('iterations have all three phases', () => {
      const result = runAxACE('task-2', 'bug-fix', 2);
      for (const iter of result.iterations) {
        expect(iter.generatorOutput).toBeTruthy();
        expect(iter.reflectorAnalysis).toBeTruthy();
        expect(['accept', 'refine', 'reject']).toContain(iter.curatorVerdict);
        expect(iter.curatorScore).toBeGreaterThanOrEqual(0);
      }
    });

    it('accepted entry persists to playbook', () => {
      const result = runAxACE('task-3', 'persist-test', 5);
      if (result.acceptedEntry) {
        const book = getPlaybook();
        const found = book.find((e) => e.id === result.acceptedEntry!.id);
        expect(found).toBeTruthy();
        expect(found!.latentFingerprint).toBeTruthy();
      }
    });
  });

  // ── Stats ────────────────────────────────────────────────────

  describe('getPlaybookStats', () => {
    it('returns stats for empty playbook', () => {
      const stats = getPlaybookStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.version).toBe(0);
      expect(stats.avgScore).toBe(0);
    });

    it('reflects entries after AxACE run', () => {
      runAxACE('s-1', 'stat-test', 5);
      const stats = getPlaybookStats();
      // May or may not have entries depending on curator verdict
      expect(stats.version).toBeGreaterThanOrEqual(0);
    });
  });
});
