/**
 * Ax Layer 5 - Self-Discover
 *
 * Google DeepMind 2024 reasoning module selection/composition.
 * Two phases:
 *   Phase 1 (SELECT+ADAPT+IMPLEMENT): pick relevant modules, compose structure
 *   Phase 2 (APPLY): use structure on task
 *
 * RecursiveMAS integration:
 *   - Composed structures -> hidden state initializers (warm start, collapses warmup rounds)
 *   - Cached structures control recursion depth (complex=8, moderate=4, linear=3)
 *
 * ~150 lines core logic (per spec). Structure caching on disk.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { LATENT_DIM } from '../hermes/types.js';
import { encodeFloat32, decodeFloat32 } from '../hermes/trace.js';

import type {
  ReasoningModule,
  ReasoningStructure,
  StructureInitializer,
  DepthOverride,
} from './types.js';
import { RECURSION_DEPTH_MAP, AX_STRUCTURES_DIR } from './types.js';

// ── Seed Modules ───────────────────────────────────────────────────
// Subset of DeepMind's 39 modules. Extensible catalog.

export const SEED_MODULES: ReasoningModule[] = [
  {
    id: 'critical_thinking',
    description: 'Evaluate evidence, identify assumptions, check logical validity',
    category: 'analytical',
    promptFragment: 'Think critically about the evidence. What assumptions are being made? Are the conclusions logically valid?',
  },
  {
    id: 'step_decomposition',
    description: 'Break complex problem into sequential substeps',
    category: 'analytical',
    promptFragment: 'Break this problem into clear, sequential steps. What must be solved first?',
  },
  {
    id: 'analogical_reasoning',
    description: 'Find similar problems and transfer solutions',
    category: 'creative',
    promptFragment: 'What similar problems have known solutions? How can those solutions transfer to this case?',
  },
  {
    id: 'counterfactual',
    description: 'Consider what would happen under different conditions',
    category: 'creative',
    promptFragment: 'What would change if key assumptions were different? Consider alternative scenarios.',
  },
  {
    id: 'constraint_analysis',
    description: 'Identify and work within explicit and implicit constraints',
    category: 'analytical',
    promptFragment: 'What are the constraints (explicit and implicit)? How do they limit the solution space?',
  },
  {
    id: 'abstraction',
    description: 'Extract general principles from specific instances',
    category: 'meta',
    promptFragment: 'What general principle or pattern underlies these specific instances?',
  },
  {
    id: 'backtracking',
    description: 'Identify when current approach fails and try alternatives',
    category: 'meta',
    promptFragment: 'If the current approach hits a dead end, what alternative paths exist? When should you abandon this approach?',
  },
  {
    id: 'hypothesis_testing',
    description: 'Form and test hypotheses systematically',
    category: 'analytical',
    promptFragment: 'Form a hypothesis. What evidence would confirm or refute it? Test systematically.',
  },
  {
    id: 'pattern_recognition',
    description: 'Identify recurring patterns and regularities',
    category: 'analytical',
    promptFragment: 'What patterns or regularities appear in the data/problem? How can they guide the solution?',
  },
  {
    id: 'metacognition',
    description: 'Monitor own reasoning process for errors and biases',
    category: 'meta',
    promptFragment: 'Step back and evaluate your reasoning. Are there biases or errors in your approach?',
  },
  {
    id: 'domain_expertise',
    description: 'Apply domain-specific knowledge and conventions',
    category: 'domain',
    promptFragment: 'What domain-specific knowledge applies here? What conventions or best practices are relevant?',
  },
  {
    id: 'risk_assessment',
    description: 'Evaluate potential risks and failure modes',
    category: 'analytical',
    promptFragment: 'What could go wrong? Identify risks, their likelihood, and potential mitigations.',
  },
];

// ── Structure Storage ──────────────────────────────────────────────

const STRUCTURES_DIR = path.join(PROJECT_ROOT, AX_STRUCTURES_DIR);
const CACHE_FILE = path.join(STRUCTURES_DIR, 'cache.json');

function ensureStructuresDir(): void {
  if (!fs.existsSync(STRUCTURES_DIR)) {
    fs.mkdirSync(STRUCTURES_DIR, { recursive: true });
  }
}

interface StructureCache {
  structures: Record<string, SerializedStructure>;
}

interface SerializedStructure extends Omit<ReasoningStructure, 'modules'> {
  id: string;
  moduleIds: string[];
}

function loadCache(): StructureCache {
  ensureStructuresDir();
  if (!fs.existsSync(CACHE_FILE)) return { structures: {} };
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as StructureCache;
  } catch {
    return { structures: {} };
  }
}

function saveCache(cache: StructureCache): void {
  ensureStructuresDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

// ── Phase 1: SELECT + ADAPT + IMPLEMENT ────────────────────────────

/**
 * Classify task complexity from description.
 * Heuristic: keyword density + length + question count.
 */
export function classifyComplexity(taskDescription: string): ReasoningStructure['complexity'] {
  const words = taskDescription.split(/\s+/).length;
  const questions = (taskDescription.match(/\?/g) || []).length;
  const complexKeywords = /multi-step|complex|recursive|interdependent|cascading|multi-agent|parallel/i;
  const linearKeywords = /simple|straightforward|single|direct|lookup|retrieve/i;

  if (complexKeywords.test(taskDescription) || words > 200 || questions > 3) {
    return 'complex';
  }
  if (linearKeywords.test(taskDescription) || words < 30) {
    return 'linear';
  }
  return 'moderate';
}

/**
 * Select relevant reasoning modules for a task.
 * Phase 1a of Self-Discover.
 */
export function selectModules(
  taskDescription: string,
  availableModules: ReasoningModule[] = SEED_MODULES,
): ReasoningModule[] {
  const complexity = classifyComplexity(taskDescription);
  const lower = taskDescription.toLowerCase();

  // Score each module by relevance
  const scored = availableModules.map((mod) => {
    let score = 0;

    // Keyword matching against module description
    const modWords = mod.description.toLowerCase().split(/\s+/);
    for (const word of modWords) {
      if (word.length > 3 && lower.includes(word)) score += 2;
    }

    // Category bonuses based on complexity
    if (complexity === 'complex' && mod.category === 'meta') score += 3;
    if (complexity === 'linear' && mod.category === 'analytical') score += 2;
    if (lower.includes('risk') && mod.id === 'risk_assessment') score += 5;
    if (lower.includes('pattern') && mod.id === 'pattern_recognition') score += 5;
    if (lower.includes('step') && mod.id === 'step_decomposition') score += 5;

    // Always include critical_thinking for complex tasks
    if (complexity === 'complex' && mod.id === 'critical_thinking') score += 4;

    return { mod, score };
  });

  // Select top modules (more for complex tasks)
  const limit = complexity === 'complex' ? 5 : complexity === 'moderate' ? 3 : 2;
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((s) => s.score > 0)
    .map((s) => s.mod);
}

/**
 * Compose a reasoning structure from selected modules.
 * Phase 1b+1c of Self-Discover.
 */
export function composeStructure(
  taskType: string,
  taskDescription: string,
  modules?: ReasoningModule[],
): ReasoningStructure {
  const selected = modules || selectModules(taskDescription);
  const complexity = classifyComplexity(taskDescription);

  // Order: analytical first, then creative, then meta (meta monitors the process)
  const categoryOrder: Record<string, number> = { analytical: 0, domain: 1, creative: 2, meta: 3 };
  const ordered = [...selected].sort(
    (a, b) => (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9),
  );

  const structure: ReasoningStructure = {
    taskType,
    modules: ordered,
    rationale: `Selected ${ordered.length} modules for ${complexity} task. Order: analysis -> domain -> creative -> meta.`,
    complexity,
    createdAt: new Date().toISOString(),
    useCount: 0,
  };

  return structure;
}

// ── Structure Caching ──────────────────────────────────────────────

/**
 * Generate cache key from task type.
 * Used for structure reuse across similar tasks.
 */
function structureCacheKey(taskType: string): string {
  return taskType.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Look up a cached structure for this task type.
 * Returns null if no cache hit.
 */
export function getCachedStructure(taskType: string): ReasoningStructure | null {
  const cache = loadCache();
  const key = structureCacheKey(taskType);
  const stored = cache.structures[key];
  if (!stored) return null;

  // Reconstitute modules from IDs
  const modules = stored.moduleIds
    .map((id) => SEED_MODULES.find((m) => m.id === id))
    .filter((m): m is ReasoningModule => m !== undefined);

  return {
    taskType: stored.taskType,
    modules,
    rationale: stored.rationale,
    complexity: stored.complexity,
    createdAt: stored.createdAt,
    useCount: stored.useCount,
  };
}

/**
 * Cache a structure for future reuse.
 */
export function cacheStructure(structure: ReasoningStructure): string {
  const cache = loadCache();
  const key = structureCacheKey(structure.taskType);
  const id = crypto.randomUUID();

  cache.structures[key] = {
    id,
    taskType: structure.taskType,
    moduleIds: structure.modules.map((m) => m.id),
    rationale: structure.rationale,
    complexity: structure.complexity,
    createdAt: structure.createdAt,
    useCount: structure.useCount,
  };

  saveCache(cache);
  logger.debug({ key, modules: structure.modules.length }, 'Self-Discover: structure cached');
  return id;
}

// ── RecursiveMAS Integration Point 1: Structure -> Hidden State ────

/**
 * Convert a reasoning structure into a warm-start hidden state initializer.
 * This is THE key integration: Self-Discover output becomes the initial
 * latent vector for the inner link, collapsing warmup rounds.
 *
 * Encoding: each module contributes a deterministic pattern to the vector
 * based on its category and position. This gives the inner link a
 * structured starting point instead of random/zero initialization.
 */
export function structureToInitializer(structure: ReasoningStructure): StructureInitializer {
  const state = new Float32Array(LATENT_DIM);

  // Encode module composition into hidden state
  for (let i = 0; i < structure.modules.length; i++) {
    const mod = structure.modules[i];
    const offset = i * Math.floor(LATENT_DIM / Math.max(structure.modules.length, 1));

    // Category encoding: different frequency patterns per category
    const categoryFreq: Record<string, number> = {
      analytical: 1.0,
      creative: 1.618, // golden ratio offset
      meta: 2.0,
      domain: 0.5,
    };
    const freq = categoryFreq[mod.category] ?? 1.0;

    // Position encoding (sinusoidal, transformer-style)
    const segmentSize = Math.floor(LATENT_DIM / Math.max(structure.modules.length, 1));
    for (let j = 0; j < segmentSize && (offset + j) < LATENT_DIM; j++) {
      const pos = j / segmentSize;
      state[offset + j] = Math.sin(pos * Math.PI * freq * (i + 1)) * 0.1;
    }

    // Module ID hash contribution (deterministic fingerprint)
    let hash = 0;
    for (let c = 0; c < mod.id.length; c++) {
      hash = ((hash << 5) - hash + mod.id.charCodeAt(c)) | 0;
    }
    // Sprinkle hash-derived values across the segment
    for (let j = 0; j < Math.min(16, segmentSize); j++) {
      const idx = offset + ((Math.abs(hash + j * 7) % segmentSize));
      if (idx < LATENT_DIM) {
        state[idx] += ((hash >> (j % 16)) & 0xFF) / 2550; // tiny contribution
      }
    }
  }

  // Normalize to unit sphere (cosine sim works best with normalized vectors)
  let norm = 0;
  for (let i = 0; i < state.length; i++) norm += state[i] * state[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < state.length; i++) state[i] /= norm;
  }

  const cacheKey = structureCacheKey(structure.taskType);
  const roundBudget = RECURSION_DEPTH_MAP[structure.complexity];

  return {
    structureId: cacheKey,
    hiddenState: state,
    roundBudget,
    cacheKey,
  };
}

// ── RecursiveMAS Integration Point 4: Depth Control ────────────────

/**
 * Get recursion depth override from Self-Discover analysis.
 * If a cached structure exists, use its complexity. Otherwise classify fresh.
 */
export function getDepthOverride(taskId: string, taskDescription: string): DepthOverride {
  // Check structure cache first
  const taskType = taskDescription.split(/[.!?]/)[0].trim(); // first sentence as type
  const cached = getCachedStructure(taskType);

  if (cached) {
    return {
      taskId,
      complexity: cached.complexity,
      rounds: RECURSION_DEPTH_MAP[cached.complexity],
      structureId: structureCacheKey(taskType),
      cached: true,
    };
  }

  // Fresh classification
  const complexity = classifyComplexity(taskDescription);
  return {
    taskId,
    complexity,
    rounds: RECURSION_DEPTH_MAP[complexity],
    structureId: '',
    cached: false,
  };
}

// ── Phase 2: APPLY ─────────────────────────────────────────────────

/**
 * Build the composed prompt from a reasoning structure.
 * This is the "apply" phase: the structure becomes a prompt preamble
 * that guides the agent's reasoning for this task.
 */
export function buildStructuredPrompt(structure: ReasoningStructure, taskDescription: string): string {
  const moduleInstructions = structure.modules
    .map((m, i) => `${i + 1}. [${m.id}] ${m.promptFragment}`)
    .join('\n');

  return [
    `Follow this reasoning structure (${structure.complexity} complexity, ${structure.modules.length} modules):`,
    '',
    moduleInstructions,
    '',
    `Apply these reasoning steps to the following task:`,
    taskDescription,
  ].join('\n');
}

/**
 * Full Self-Discover pipeline: compose structure, initialize hidden state, return both.
 * Entry point for L5 integration with Hermes L4.
 */
export function discover(
  taskId: string,
  taskType: string,
  taskDescription: string,
): {
  structure: ReasoningStructure;
  initializer: StructureInitializer;
  depthOverride: DepthOverride;
  prompt: string;
  cached: boolean;
} {
  // Try cache first
  let structure = getCachedStructure(taskType);
  let cached = false;

  if (structure) {
    structure.useCount++;
    cached = true;
    logger.debug({ taskType, useCount: structure.useCount }, 'Self-Discover: cache hit');
  } else {
    structure = composeStructure(taskType, taskDescription);
    cacheStructure(structure);
    logger.debug({ taskType, modules: structure.modules.length }, 'Self-Discover: new structure composed');
  }

  const initializer = structureToInitializer(structure);
  const depthOverride = getDepthOverride(taskId, taskDescription);
  const prompt = buildStructuredPrompt(structure, taskDescription);

  return { structure, initializer, depthOverride, prompt, cached };
}
