/**
 * Ax Layer 5 - Self-Discover Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { LATENT_DIM } from '../hermes/types.js';

import {
  SEED_MODULES,
  classifyComplexity,
  selectModules,
  composeStructure,
  structureToInitializer,
  getDepthOverride,
  buildStructuredPrompt,
  discover,
  getCachedStructure,
  cacheStructure,
} from './self-discover.js';
import { RECURSION_DEPTH_MAP, AX_STRUCTURES_DIR } from './types.js';

// ── Cleanup ────────────────────────────────────────────────────────

const STRUCTURES_DIR = path.join(PROJECT_ROOT, AX_STRUCTURES_DIR);

function cleanStructures(): void {
  if (fs.existsSync(STRUCTURES_DIR)) {
    fs.rmSync(STRUCTURES_DIR, { recursive: true, force: true });
  }
}

describe('Self-Discover', () => {
  beforeEach(() => cleanStructures());
  afterEach(() => cleanStructures());

  // ── Seed Modules ───────────────────────────────────────────────

  describe('SEED_MODULES', () => {
    it('has at least 10 seed modules', () => {
      expect(SEED_MODULES.length).toBeGreaterThanOrEqual(10);
    });

    it('each module has required fields', () => {
      for (const mod of SEED_MODULES) {
        expect(mod.id).toBeTruthy();
        expect(mod.description).toBeTruthy();
        expect(mod.category).toMatch(/^(analytical|creative|meta|domain)$/);
        expect(mod.promptFragment).toBeTruthy();
      }
    });

    it('module IDs are unique', () => {
      const ids = SEED_MODULES.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ── Complexity Classification ──────────────────────────────────

  describe('classifyComplexity', () => {
    it('classifies short simple tasks as linear', () => {
      expect(classifyComplexity('simple lookup task')).toBe('linear');
    });

    it('classifies complex multi-step tasks', () => {
      expect(classifyComplexity('complex multi-step recursive analysis with interdependent variables')).toBe('complex');
    });

    it('classifies moderate tasks', () => {
      expect(classifyComplexity('Analyze this code file and suggest improvements for better maintainability across multiple modules with consideration for team readability and long-term evolution of the architecture, paying attention to naming conventions, test coverage gaps, and potential performance bottlenecks in the hot path')).toBe('moderate');
    });

    it('long descriptions trend complex', () => {
      const long = 'word '.repeat(250);
      expect(classifyComplexity(long)).toBe('complex');
    });
  });

  // ── Module Selection ───────────────────────────────────────────

  describe('selectModules', () => {
    it('selects modules for task', () => {
      const modules = selectModules('analyze patterns in data and identify risks');
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.length).toBeLessThanOrEqual(5);
    });

    it('selects fewer modules for linear tasks', () => {
      const linear = selectModules('simple retrieve value');
      const complex = selectModules('complex multi-step recursive analysis with cascading dependencies');
      expect(linear.length).toBeLessThanOrEqual(complex.length);
    });

    it('returns ReasoningModule objects', () => {
      const modules = selectModules('step by step analysis of risk');
      for (const mod of modules) {
        expect(mod).toHaveProperty('id');
        expect(mod).toHaveProperty('description');
        expect(mod).toHaveProperty('category');
        expect(mod).toHaveProperty('promptFragment');
      }
    });
  });

  // ── Structure Composition ──────────────────────────────────────

  describe('composeStructure', () => {
    it('creates structure with ordered modules', () => {
      const structure = composeStructure('code-review', 'Review this code for bugs and patterns');
      expect(structure.taskType).toBe('code-review');
      expect(structure.modules.length).toBeGreaterThan(0);
      expect(structure.complexity).toBeTruthy();
      expect(structure.rationale).toBeTruthy();
      expect(structure.createdAt).toBeTruthy();
    });

    it('orders modules: analytical before meta', () => {
      const structure = composeStructure(
        'deep-analysis',
        'complex multi-step recursive analysis with cascading multi-agent coordination',
      );
      const categories = structure.modules.map((m) => m.category);
      const analyticalIdx = categories.indexOf('analytical');
      const metaIdx = categories.indexOf('meta');
      if (analyticalIdx >= 0 && metaIdx >= 0) {
        expect(analyticalIdx).toBeLessThan(metaIdx);
      }
    });
  });

  // ── Structure -> Hidden State Initializer ──────────────────────

  describe('structureToInitializer', () => {
    it('produces 768-dim hidden state', () => {
      const structure = composeStructure('test', 'analyze patterns and risks');
      const init = structureToInitializer(structure);
      expect(init.hiddenState.length).toBe(LATENT_DIM);
    });

    it('produces normalized vector (unit sphere)', () => {
      const structure = composeStructure('test', 'complex multi-step analysis');
      const init = structureToInitializer(structure);
      let norm = 0;
      for (let i = 0; i < init.hiddenState.length; i++) {
        norm += init.hiddenState[i] * init.hiddenState[i];
      }
      norm = Math.sqrt(norm);
      expect(norm).toBeCloseTo(1.0, 1);
    });

    it('maps complexity to round budget', () => {
      const linear = composeStructure('linear-task', 'simple lookup');
      const complex = composeStructure('complex-task', 'complex multi-step recursive cascading analysis');

      expect(structureToInitializer(linear).roundBudget).toBe(RECURSION_DEPTH_MAP.linear);
      expect(structureToInitializer(complex).roundBudget).toBe(RECURSION_DEPTH_MAP.complex);
    });

    it('different structures produce different states', () => {
      const s1 = composeStructure('analysis', 'analyze risk patterns');
      const s2 = composeStructure('creative', 'brainstorm new ideas and analogies');
      const i1 = structureToInitializer(s1);
      const i2 = structureToInitializer(s2);

      // Not identical
      let same = true;
      for (let i = 0; i < LATENT_DIM; i++) {
        if (Math.abs(i1.hiddenState[i] - i2.hiddenState[i]) > 1e-6) {
          same = false;
          break;
        }
      }
      expect(same).toBe(false);
    });
  });

  // ── Structure Caching ──────────────────────────────────────────

  describe('caching', () => {
    it('caches and retrieves structure', () => {
      const structure = composeStructure('cached-type', 'analyze something');
      cacheStructure(structure);

      const retrieved = getCachedStructure('cached-type');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.taskType).toBe('cached-type');
      expect(retrieved!.modules.length).toBe(structure.modules.length);
    });

    it('returns null for uncached', () => {
      expect(getCachedStructure('nonexistent-type')).toBeNull();
    });
  });

  // ── Depth Override ─────────────────────────────────────────────

  describe('getDepthOverride', () => {
    it('returns depth override for task', () => {
      const override = getDepthOverride('task-1', 'simple direct lookup');
      expect(override.taskId).toBe('task-1');
      expect(override.complexity).toBeTruthy();
      expect(override.rounds).toBeGreaterThan(0);
    });

    it('linear = 3, complex = 8', () => {
      const linear = getDepthOverride('t1', 'simple retrieve');
      const complex = getDepthOverride('t2', 'complex multi-step recursive cascading analysis');
      expect(linear.rounds).toBe(3);
      expect(complex.rounds).toBe(8);
    });

    it('uses cached structure when available', () => {
      const structure = composeStructure('Cached task type', 'complex multi-step recursive work');
      cacheStructure(structure);

      const override = getDepthOverride('t3', 'Cached task type. Do the thing.');
      expect(override.cached).toBe(true);
    });
  });

  // ── Structured Prompt ──────────────────────────────────────────

  describe('buildStructuredPrompt', () => {
    it('builds prompt with module instructions', () => {
      const structure = composeStructure('test', 'analyze patterns and risks');
      const prompt = buildStructuredPrompt(structure, 'Find bugs in this code');
      expect(prompt).toContain('reasoning structure');
      expect(prompt).toContain('Find bugs in this code');
      expect(prompt).toContain('[');
    });
  });

  // ── Full Pipeline ──────────────────────────────────────────────

  describe('discover', () => {
    it('returns structure + initializer + depth + prompt', () => {
      const result = discover('task-1', 'analysis', 'analyze risk patterns in data');
      expect(result.structure).toBeTruthy();
      expect(result.initializer.hiddenState.length).toBe(LATENT_DIM);
      expect(result.depthOverride.rounds).toBeGreaterThan(0);
      expect(result.prompt).toBeTruthy();
    });

    it('second call hits cache', () => {
      discover('t1', 'repeat-type', 'analyze something');
      const second = discover('t2', 'repeat-type', 'analyze something else');
      expect(second.cached).toBe(true);
    });
  });
});
