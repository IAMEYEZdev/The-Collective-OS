/**
 * Ax Layer 5 - MiPRO Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { LATENT_DIM } from '../hermes/types.js';

import {
  generateCandidates,
  scoreCandidate,
  promptToLatentPrior,
  computeLatentMetrics,
  optimize,
  getCompiledPrompt,
  listArtifacts,
} from './mipro.js';
import { AX_MIPRO_DIR } from './types.js';

// ── Cleanup ────────────────────────────────────────────────────────

const MIPRO_DIR = path.join(PROJECT_ROOT, AX_MIPRO_DIR);

function cleanMipro(): void {
  if (fs.existsSync(MIPRO_DIR)) {
    fs.rmSync(MIPRO_DIR, { recursive: true, force: true });
  }
}

describe('MiPRO', () => {
  beforeEach(() => cleanMipro());
  afterEach(() => cleanMipro());

  // ── Candidate Generation ─────────────────────────────────────

  describe('generateCandidates', () => {
    it('returns at least the base prompt', () => {
      const candidates = generateCandidates('test prompt', 3, 0.5);
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates[0]).toBe('test prompt');
    });

    it('respects numCandidates limit', () => {
      const candidates = generateCandidates('test prompt', 5, 1.0);
      expect(candidates.length).toBeLessThanOrEqual(5);
    });

    it('higher temperature produces more mutations', () => {
      const low = generateCandidates('test prompt', 10, 0.1);
      const high = generateCandidates('test prompt', 10, 1.0);
      expect(high.length).toBeGreaterThanOrEqual(low.length);
    });

    it('mutations are different from base', () => {
      const candidates = generateCandidates('base prompt here', 4, 0.8);
      if (candidates.length > 1) {
        expect(candidates[1]).not.toBe(candidates[0]);
      }
    });
  });

  // ── Scoring ──────────────────────────────────────────────────

  describe('scoreCandidate', () => {
    it('returns score between 0 and 1', () => {
      const score = scoreCandidate('analyze this step by step', []);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('structured prompts score higher', () => {
      const plain = scoreCandidate('do the thing', []);
      const structured = scoreCandidate('Let us approach this step by step. 1. First analyze. 2. Then verify your answer.', []);
      expect(structured).toBeGreaterThan(plain);
    });

    it('penalizes very short prompts', () => {
      const short = scoreCandidate('hi', []);
      const normal = scoreCandidate('Analyze this code for bugs and verify the output', []);
      expect(normal).toBeGreaterThan(short);
    });
  });

  // ── Prompt -> Latent Prior ───────────────────────────────────

  describe('promptToLatentPrior', () => {
    it('produces 768-dim latent payload', () => {
      const prior = promptToLatentPrior('analyze step by step');
      expect(prior.data.length).toBe(LATENT_DIM);
      expect(prior.dim).toBe(LATENT_DIM);
      expect(prior.numVectors).toBe(1);
      expect(prior.adapterKey).toBe('mipro-prior');
    });

    it('produces normalized vector', () => {
      const prior = promptToLatentPrior('check verify validate test');
      let norm = 0;
      for (let i = 0; i < prior.data.length; i++) {
        norm += prior.data[i] * prior.data[i];
      }
      norm = Math.sqrt(norm);
      expect(norm).toBeCloseTo(1.0, 1);
    });

    it('different prompts produce different vectors', () => {
      const p1 = promptToLatentPrior('analyze code for bugs');
      const p2 = promptToLatentPrior('write creative poetry');
      let same = true;
      for (let i = 0; i < LATENT_DIM; i++) {
        if (Math.abs(p1.data[i] - p2.data[i]) > 1e-6) {
          same = false;
          break;
        }
      }
      expect(same).toBe(false);
    });

    it('encodes step-by-step pattern', () => {
      const withSteps = promptToLatentPrior('approach this step by step carefully');
      const without = promptToLatentPrior('do the thing now please');
      // First quarter should differ due to ramp encoding
      let firstQuarterDiff = 0;
      const q = Math.floor(LATENT_DIM / 4);
      for (let i = 0; i < q; i++) {
        firstQuarterDiff += Math.abs(withSteps.data[i] - without.data[i]);
      }
      expect(firstQuarterDiff).toBeGreaterThan(0);
    });
  });

  // ── Latent Metrics ───────────────────────────────────────────

  describe('computeLatentMetrics', () => {
    it('returns zeros for nonexistent task', () => {
      const metrics = computeLatentMetrics('nonexistent-task-id');
      expect(metrics.convergenceSpeed).toBe(0);
      expect(metrics.hiddenStateStability).toBe(0);
    });
  });

  // ── Optimization ─────────────────────────────────────────────

  describe('optimize', () => {
    it('returns compiled prompt with metrics', () => {
      const result = optimize('base prompt for analysis', 'test-module', {
        maxIterations: 2,
        evalExamples: [],
        useLatentMetrics: false,
        temperature: 0.5,
        numCandidates: 3,
      });

      expect(result.id).toBeTruthy();
      expect(result.prompt).toBeTruthy();
      expect(result.targetModule).toBe('test-module');
      expect(result.metrics.accuracy).toBeGreaterThan(0);
      expect(result.latentPrior).toBeTruthy();
      expect(result.latentPrior!.data.length).toBe(LATENT_DIM);
    });

    it('persists artifact for retrieval', () => {
      optimize('test prompt', 'persist-test', {
        maxIterations: 1,
        evalExamples: [],
        useLatentMetrics: false,
        temperature: 0.5,
        numCandidates: 2,
      });

      const retrieved = getCompiledPrompt('persist-test');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.targetModule).toBe('persist-test');
      expect(retrieved!.latentPrior).toBeTruthy();
    });

    it('improvement is non-negative for good mutations', () => {
      const result = optimize('do thing', 'improvement-test', {
        maxIterations: 3,
        evalExamples: [],
        useLatentMetrics: false,
        temperature: 0.8,
        numCandidates: 5,
      });
      expect(result.metrics.improvementOverBaseline).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Artifact Listing ─────────────────────────────────────────

  describe('listArtifacts', () => {
    it('lists all stored artifacts', () => {
      optimize('prompt 1', 'mod-a', {
        maxIterations: 1, evalExamples: [], useLatentMetrics: false, temperature: 0.5, numCandidates: 2,
      });
      optimize('prompt 2', 'mod-b', {
        maxIterations: 1, evalExamples: [], useLatentMetrics: false, temperature: 0.5, numCandidates: 2,
      });

      const list = listArtifacts();
      expect(list.length).toBe(2);
      const modules = list.map((a) => a.targetModule);
      expect(modules).toContain('mod-a');
      expect(modules).toContain('mod-b');
    });
  });
});
