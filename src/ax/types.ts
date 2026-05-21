/**
 * Ax Layer 5 - Core Types
 *
 * Three components:
 *   1. Self-Discover: reasoning module selection/composition
 *   2. MiPRO: prompt optimization with latent metrics
 *   3. AxACE: Generator-Reflector-Curator playbook loop
 *
 * RecursiveMAS integration points (5 modifications from Annika's spec):
 *   1. Self-Discover structures -> inner link hidden state initializers
 *   2. MiPRO artifacts -> latent priors for first inner link round
 *   3. AxACE playbook built from recursion traces (not surface text)
 *   4. Self-Discover cached structures control recursion depth
 *   5. MiPRO re-optimization with latent performance metrics
 */

import type { LatentPayload, TraceEntry } from '../hermes/types.js';

// ── Self-Discover Types ────────────────────────────────────────────

/**
 * A reasoning module: one atomic reasoning capability.
 * Google DeepMind 2024 Self-Discover defines ~39 seed modules.
 * We keep the catalog extensible.
 */
export interface ReasoningModule {
  /** Unique module ID (e.g. 'critical_thinking', 'step_decomposition') */
  id: string;
  /** Human-readable description of what this module does */
  description: string;
  /** Category for filtering (e.g. 'analytical', 'creative', 'meta') */
  category: 'analytical' | 'creative' | 'meta' | 'domain';
  /** Prompt fragment that activates this module */
  promptFragment: string;
}

/**
 * A composed reasoning structure: selected + ordered modules for a task.
 * Phase 1 output of Self-Discover.
 */
export interface ReasoningStructure {
  /** Task type this structure was composed for */
  taskType: string;
  /** Selected modules in execution order */
  modules: ReasoningModule[];
  /** Composition rationale (why these modules, this order) */
  rationale: string;
  /** Estimated complexity: controls recursion depth */
  complexity: 'linear' | 'moderate' | 'complex';
  /** Created timestamp */
  createdAt: string;
  /** How many times this structure has been used */
  useCount: number;
}

/**
 * RecursiveMAS integration: Self-Discover structure -> hidden state initializer.
 * Converts the composed reasoning structure into a warm-start latent vector.
 */
export interface StructureInitializer {
  /** The reasoning structure that produced this */
  structureId: string;
  /** Warm-start hidden state vector (dim=768) */
  hiddenState: Float32Array;
  /** Complexity-derived round budget override */
  roundBudget: number;
  /** Cache key for structure reuse */
  cacheKey: string;
}

// ── MiPRO Types ────────────────────────────────────────────────────

/**
 * A compiled prompt artifact from MiPRO optimization.
 * In RecursiveMAS mode: also carries latent priors.
 */
export interface CompiledPrompt {
  /** Unique artifact ID */
  id: string;
  /** The optimized prompt text */
  prompt: string;
  /** Which task/module this was optimized for */
  targetModule: string;
  /** Optimization metrics from compilation */
  metrics: MiPROMetrics;
  /** Latent prior: injected as first inner link round input (integration point 2) */
  latentPrior?: LatentPayload;
  /** Optimization iteration that produced this */
  iteration: number;
  /** Created timestamp */
  createdAt: string;
}

/**
 * Metrics tracked during MiPRO optimization.
 * Integration point 5: includes latent performance metrics.
 */
export interface MiPROMetrics {
  /** Task accuracy on evaluation set */
  accuracy: number;
  /** Convergence speed: rounds to reach delta < 0.02 */
  convergenceSpeed: number;
  /** Hidden state stability: variance of delta across rounds */
  hiddenStateStability: number;
  /** Token cost of the compiled prompt */
  tokenCost: number;
  /** Improvement over baseline (percentage) */
  improvementOverBaseline: number;
}

/**
 * MiPRO optimization config for a single run.
 */
export interface MiPROConfig {
  /** Number of optimization iterations */
  maxIterations: number;
  /** Evaluation examples for scoring */
  evalExamples: EvalExample[];
  /** Whether to include latent metrics in loss function */
  useLatentMetrics: boolean;
  /** Temperature for prompt candidates */
  temperature: number;
  /** Number of candidates per iteration */
  numCandidates: number;
}

export interface EvalExample {
  input: string;
  expectedOutput: string;
  metadata?: Record<string, unknown>;
}

// ── AxACE Types ────────────────────────────────────────────────────

/**
 * A playbook entry: one learned strategy from the Generator-Reflector-Curator loop.
 * Integration point 3: built from recursion traces, not surface text.
 */
export interface PlaybookEntry {
  /** Unique entry ID */
  id: string;
  /** Task type / pattern this entry applies to */
  taskPattern: string;
  /** The strategy (human-readable) */
  strategy: string;
  /** Latent fingerprint: mean hidden state from the traces that produced this entry */
  latentFingerprint?: Float32Array;
  /** Source trace IDs that informed this entry */
  sourceTraceIds: string[];
  /** Performance score (0-1) from Curator evaluation */
  curatorScore: number;
  /** Number of times this entry has been applied */
  applicationCount: number;
  /** Last time this entry was updated */
  updatedAt: string;
  /** Created timestamp */
  createdAt: string;
}

/**
 * The full playbook: persistent on disk, grows each session.
 * Stored at store/ax-playbook/playbook.json
 */
export interface Playbook {
  /** All entries, keyed by entry ID */
  entries: Map<string, PlaybookEntry>;
  /** Version counter (incremented on each save) */
  version: number;
  /** Last modified timestamp */
  lastModified: string;
}

/**
 * AxACE loop roles.
 */
export type AxACERole = 'generator' | 'reflector' | 'curator';

/**
 * Result from one AxACE loop iteration.
 */
export interface AxACEIteration {
  /** Iteration number */
  round: number;
  /** Generator output: candidate strategy */
  generatorOutput: string;
  /** Reflector analysis: strengths, weaknesses, trace-informed feedback */
  reflectorAnalysis: string;
  /** Curator verdict: accept, refine, or reject */
  curatorVerdict: 'accept' | 'refine' | 'reject';
  /** Curator score (0-1) */
  curatorScore: number;
  /** Trace references used in this iteration */
  traceRefs: string[];
  /** Latent state snapshot at this iteration */
  latentSnapshot?: Float32Array;
}

/**
 * Full result from an AxACE session.
 */
export interface AxACEResult {
  /** Task that triggered this session */
  taskId: string;
  /** All iterations */
  iterations: AxACEIteration[];
  /** Final accepted playbook entry (or null if all rejected) */
  acceptedEntry: PlaybookEntry | null;
  /** Whether the loop converged (curator accepted) */
  converged: boolean;
  /** Total rounds executed */
  roundsExecuted: number;
}

// ── Recursion Depth Control (Integration Point 4) ──────────────────

/**
 * Complexity-to-depth mapping from Self-Discover cached structures.
 * Locked: complex=8, moderate=4, linear=3
 */
export const RECURSION_DEPTH_MAP: Record<ReasoningStructure['complexity'], number> = {
  complex: 8,
  moderate: 4,
  linear: 3,
};

/**
 * Round budget override from Self-Discover analysis.
 * When Self-Discover classifies a task, this controls how many
 * inner link recursion rounds the agent gets.
 */
export interface DepthOverride {
  /** Task ID this applies to */
  taskId: string;
  /** Complexity classification */
  complexity: ReasoningStructure['complexity'];
  /** Actual round budget */
  rounds: number;
  /** Which reasoning structure determined this */
  structureId: string;
  /** Cache hit: true if reused from a previous structure */
  cached: boolean;
}

// ── Storage Paths ──────────────────────────────────────────────────

/** Playbook storage directory */
export const AX_PLAYBOOK_DIR = 'store/ax-playbook';
/** Self-Discover structure cache */
export const AX_STRUCTURES_DIR = 'store/ax-structures';
/** MiPRO compiled prompts */
export const AX_MIPRO_DIR = 'store/ax-mipro';
