/**
 * Ax Layer 5 - Barrel Exports
 *
 * Three components: Self-Discover, MiPRO, AxACE
 * All integrate with Hermes L4 latent vector infrastructure.
 */

// ── Types ──────────────────────────────────────────────────────────

export type {
  ReasoningModule,
  ReasoningStructure,
  StructureInitializer,
  CompiledPrompt,
  MiPROMetrics,
  MiPROConfig,
  EvalExample,
  PlaybookEntry,
  Playbook,
  AxACERole,
  AxACEIteration,
  AxACEResult,
  DepthOverride,
} from './types.js';

export {
  RECURSION_DEPTH_MAP,
  AX_PLAYBOOK_DIR,
  AX_STRUCTURES_DIR,
  AX_MIPRO_DIR,
} from './types.js';

// ── Self-Discover ──────────────────────────────────────────────────

export {
  SEED_MODULES,
  classifyComplexity,
  selectModules,
  composeStructure,
  getCachedStructure,
  cacheStructure,
  structureToInitializer,
  getDepthOverride,
  buildStructuredPrompt,
  discover,
} from './self-discover.js';

// ── MiPRO ──────────────────────────────────────────────────────────

export {
  generateCandidates,
  scoreCandidate,
  promptToLatentPrior,
  computeLatentMetrics,
  optimize,
  reoptimize,
  getCompiledPrompt,
  listArtifacts,
} from './mipro.js';

// ── AxACE ──────────────────────────────────────────────────────────

export {
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

// ── Convenience Namespace ──────────────────────────────────────────

import { SEED_MODULES, classifyComplexity, selectModules, composeStructure, getCachedStructure, cacheStructure, structureToInitializer, getDepthOverride, buildStructuredPrompt, discover } from './self-discover.js';
import { generateCandidates, scoreCandidate, promptToLatentPrior, computeLatentMetrics, optimize, reoptimize, getCompiledPrompt, listArtifacts } from './mipro.js';
import { getPlaybook, matchPlaybook, upsertPlaybookEntry, analyzeTracesForReflection, generate, reflect, curate, runAxACE, getPlaybookStats } from './axace.js';
import { RECURSION_DEPTH_MAP, AX_PLAYBOOK_DIR, AX_STRUCTURES_DIR, AX_MIPRO_DIR } from './types.js';

/** Convenience namespace for all Ax L5 exports. */
export const ax = {
  // Constants
  RECURSION_DEPTH_MAP,
  AX_PLAYBOOK_DIR,
  AX_STRUCTURES_DIR,
  AX_MIPRO_DIR,

  // Self-Discover
  SEED_MODULES,
  classifyComplexity,
  selectModules,
  composeStructure,
  getCachedStructure,
  cacheStructure,
  structureToInitializer,
  getDepthOverride,
  buildStructuredPrompt,
  discover,

  // MiPRO
  generateCandidates,
  scoreCandidate,
  promptToLatentPrior,
  computeLatentMetrics,
  optimize,
  reoptimize,
  getCompiledPrompt,
  listArtifacts,

  // AxACE
  getPlaybook,
  matchPlaybook,
  upsertPlaybookEntry,
  analyzeTracesForReflection,
  generate,
  reflect,
  curate,
  runAxACE,
  getPlaybookStats,
} as const;
