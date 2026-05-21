/**
 * Ax Layer 5 - AxACE (Generator-Reflector-Curator)
 *
 * Persistent playbook loop. Each session:
 *   1. Generator proposes strategies for a task
 *   2. Reflector analyzes using recursion trace data (not surface text)
 *   3. Curator accepts, refines, or rejects
 *
 * RecursiveMAS integration:
 *   - Integration point 3: playbook built from recursion traces, not text.
 *     The Reflector reads Hermes trace data (convergence trajectories,
 *     hidden state evolution, anomaly patterns) instead of surface-level
 *     text output. Richer signal: reasoning evolution is visible.
 *
 * Playbook persists on disk at store/ax-playbook/playbook.json.
 * Grows each session. Borg Queen (L6) queries it when routing tasks.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { LATENT_DIM } from '../hermes/types.js';
import type { TraceEntry } from '../hermes/types.js';
import type { SerializedTrace } from '../hermes/trace.js';
import { readTraces, decodeFloat32, encodeFloat32 } from '../hermes/trace.js';
import { cosineSimilarity } from '../hermes/transport.js';

import type {
  PlaybookEntry,
  Playbook,
  AxACEIteration,
  AxACEResult,
} from './types.js';
import { AX_PLAYBOOK_DIR } from './types.js';

// ── Playbook Storage ───────────────────────────────────────────────

const PLAYBOOK_DIR = path.join(PROJECT_ROOT, AX_PLAYBOOK_DIR);
const PLAYBOOK_FILE = path.join(PLAYBOOK_DIR, 'playbook.json');

function ensurePlaybookDir(): void {
  if (!fs.existsSync(PLAYBOOK_DIR)) {
    fs.mkdirSync(PLAYBOOK_DIR, { recursive: true });
  }
}

interface SerializedPlaybook {
  entries: Record<string, SerializedPlaybookEntry>;
  version: number;
  lastModified: string;
}

interface SerializedPlaybookEntry extends Omit<PlaybookEntry, 'latentFingerprint'> {
  latentFingerprint?: string; // base64
}

function loadPlaybook(): SerializedPlaybook {
  ensurePlaybookDir();
  if (!fs.existsSync(PLAYBOOK_FILE)) {
    return { entries: {}, version: 0, lastModified: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(PLAYBOOK_FILE, 'utf-8')) as SerializedPlaybook;
  } catch {
    return { entries: {}, version: 0, lastModified: new Date().toISOString() };
  }
}

function savePlaybook(playbook: SerializedPlaybook): void {
  ensurePlaybookDir();
  playbook.version++;
  playbook.lastModified = new Date().toISOString();
  fs.writeFileSync(PLAYBOOK_FILE, JSON.stringify(playbook, null, 2), 'utf-8');
  logger.debug({ version: playbook.version, entries: Object.keys(playbook.entries).length }, 'AxACE: playbook saved');
}

// ── Playbook API ───────────────────────────────────────────────────

/**
 * Get all playbook entries.
 */
export function getPlaybook(): PlaybookEntry[] {
  const stored = loadPlaybook();
  return Object.values(stored.entries).map(deserializeEntry);
}

/**
 * Get playbook entries matching a task pattern.
 * Uses substring match + latent similarity if fingerprint available.
 */
export function matchPlaybook(
  taskPattern: string,
  latentState?: Float32Array,
): PlaybookEntry[] {
  const all = getPlaybook();
  const lower = taskPattern.toLowerCase();

  // Text matching
  const textMatches = all.filter((e) => {
    const entryLower = e.taskPattern.toLowerCase();
    return entryLower.includes(lower) || lower.includes(entryLower);
  });

  // Latent matching (if state provided)
  if (latentState && latentState.length === LATENT_DIM) {
    const latentMatches = all
      .filter((e) => e.latentFingerprint && e.latentFingerprint.length === LATENT_DIM)
      .map((e) => ({
        entry: e,
        sim: cosineSimilarity(latentState, e.latentFingerprint!),
      }))
      .filter((m) => m.sim > 0.7) // similarity threshold
      .sort((a, b) => b.sim - a.sim);

    // Merge: text matches first, then latent matches not already included
    const textIds = new Set(textMatches.map((e) => e.id));
    const latentOnly = latentMatches
      .filter((m) => !textIds.has(m.entry.id))
      .map((m) => m.entry);

    return [...textMatches, ...latentOnly];
  }

  return textMatches;
}

/**
 * Add or update a playbook entry.
 */
export function upsertPlaybookEntry(entry: PlaybookEntry): void {
  const stored = loadPlaybook();
  stored.entries[entry.id] = serializeEntry(entry);
  savePlaybook(stored);
}

function serializeEntry(entry: PlaybookEntry): SerializedPlaybookEntry {
  return {
    ...entry,
    latentFingerprint: entry.latentFingerprint
      ? encodeFloat32(entry.latentFingerprint)
      : undefined,
  };
}

function deserializeEntry(stored: SerializedPlaybookEntry): PlaybookEntry {
  return {
    ...stored,
    latentFingerprint: stored.latentFingerprint
      ? decodeFloat32(stored.latentFingerprint)
      : undefined,
  };
}

// ── Trace-Based Reflection (Integration Point 3) ──────────────────

/**
 * Analyze recursion traces to extract reflection insights.
 * This is THE key difference from text-based AxACE: we read the actual
 * convergence trajectory and hidden state evolution, not just surface text.
 */
export function analyzeTracesForReflection(taskId: string): {
  convergenceTrajectory: Array<{ round: number; delta: number }>;
  anomalies: string[];
  meanState: Float32Array;
  traceIds: string[];
  totalRounds: number;
} {
  const traces = readTraces(taskId);
  const meanState = new Float32Array(LATENT_DIM);
  const traceIds: string[] = [];
  const convergenceTrajectory: Array<{ round: number; delta: number }> = [];
  const anomalies: string[] = [];

  if (traces.length === 0) {
    return { convergenceTrajectory, anomalies, meanState, traceIds, totalRounds: 0 };
  }

  // Process each trace
  let stateCount = 0;
  let prevDelta: number | null = null;

  for (const trace of traces) {
    traceIds.push(trace.id);

    // Accumulate mean hidden state
    const state = decodeFloat32(trace.hiddenState);
    if (state.length === LATENT_DIM) {
      for (let i = 0; i < LATENT_DIM; i++) {
        meanState[i] += state[i];
      }
      stateCount++;
    }

    // Track convergence
    if (trace.convergenceDelta !== null) {
      convergenceTrajectory.push({
        round: trace.round,
        delta: trace.convergenceDelta,
      });

      // Detect anomalies
      if (prevDelta !== null) {
        if (trace.convergenceDelta > prevDelta * 1.5) {
          anomalies.push(`Divergence spike at round ${trace.round}: delta ${trace.convergenceDelta.toFixed(4)} > prev ${prevDelta.toFixed(4)}`);
        }
        if (Math.abs(trace.convergenceDelta - prevDelta) < 0.001 && trace.round > 2) {
          anomalies.push(`Stagnation at round ${trace.round}: delta stuck at ${trace.convergenceDelta.toFixed(4)}`);
        }
      }
      prevDelta = trace.convergenceDelta;
    }
  }

  // Normalize mean state
  if (stateCount > 0) {
    for (let i = 0; i < LATENT_DIM; i++) {
      meanState[i] /= stateCount;
    }
  }

  // Normalize to unit sphere
  let norm = 0;
  for (let i = 0; i < LATENT_DIM; i++) norm += meanState[i] * meanState[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < LATENT_DIM; i++) meanState[i] /= norm;
  }

  const maxRound = traces.reduce((max, t) => Math.max(max, t.round), 0);

  return {
    convergenceTrajectory,
    anomalies,
    meanState,
    traceIds,
    totalRounds: maxRound + 1,
  };
}

// ── Generator ──────────────────────────────────────────────────────

/**
 * Generate a candidate strategy for a task.
 * In full implementation: calls LLM. Here: structural generation
 * based on trace analysis + existing playbook patterns.
 */
export function generate(
  taskPattern: string,
  traceAnalysis: ReturnType<typeof analyzeTracesForReflection>,
  existingStrategies: PlaybookEntry[],
): string {
  const parts: string[] = [];

  parts.push(`Strategy for task pattern: "${taskPattern}"`);

  // Inform by convergence behavior
  if (traceAnalysis.convergenceTrajectory.length > 0) {
    const finalDelta = traceAnalysis.convergenceTrajectory.at(-1)?.delta ?? 1;
    if (finalDelta < 0.02) {
      parts.push(`Prior runs converged (final delta: ${finalDelta.toFixed(4)}). Maintain current approach with refinements.`);
    } else if (finalDelta < 0.1) {
      parts.push(`Prior runs nearly converged (delta: ${finalDelta.toFixed(4)}). Increase round budget or simplify reasoning path.`);
    } else {
      parts.push(`Prior runs did not converge (delta: ${finalDelta.toFixed(4)}). Major strategy revision needed.`);
    }
  }

  // Inform by anomalies
  if (traceAnalysis.anomalies.length > 0) {
    parts.push(`Anomalies detected: ${traceAnalysis.anomalies.join('; ')}`);
    parts.push('Strategy should address anomaly root causes.');
  }

  // Build on existing strategies
  if (existingStrategies.length > 0) {
    const best = existingStrategies.sort((a, b) => b.curatorScore - a.curatorScore)[0];
    parts.push(`Building on proven strategy (score ${best.curatorScore.toFixed(2)}): ${best.strategy}`);
  }

  return parts.join('\n');
}

// ── Reflector ──────────────────────────────────────────────────────

/**
 * Reflect on a generated strategy using trace data.
 * Key difference: reads convergence trajectory and hidden state patterns,
 * not just the surface text output.
 */
export function reflect(
  generatorOutput: string,
  traceAnalysis: ReturnType<typeof analyzeTracesForReflection>,
): string {
  const observations: string[] = [];

  // Convergence quality
  if (traceAnalysis.totalRounds > 0) {
    const convergedRatio = traceAnalysis.convergenceTrajectory
      .filter((t) => t.delta < 0.02).length / Math.max(traceAnalysis.convergenceTrajectory.length, 1);
    observations.push(`Convergence rate: ${(convergedRatio * 100).toFixed(0)}% of rounds`);

    // Trend analysis
    if (traceAnalysis.convergenceTrajectory.length >= 3) {
      const last3 = traceAnalysis.convergenceTrajectory.slice(-3);
      const improving = last3[2]?.delta < last3[0]?.delta;
      observations.push(improving ? 'Trend: improving (deltas decreasing)' : 'Trend: degrading (deltas increasing)');
    }
  }

  // Anomaly assessment
  if (traceAnalysis.anomalies.length > 0) {
    observations.push(`${traceAnalysis.anomalies.length} anomalies need addressing`);
    // Check if strategy addresses them
    for (const anomaly of traceAnalysis.anomalies) {
      if (anomaly.includes('Divergence') && !generatorOutput.includes('divergen')) {
        observations.push('WARNING: strategy does not address divergence anomaly');
      }
      if (anomaly.includes('Stagnation') && !generatorOutput.includes('stagnat')) {
        observations.push('WARNING: strategy does not address stagnation anomaly');
      }
    }
  } else {
    observations.push('No anomalies detected in trace data');
  }

  // Hidden state quality
  const stateNorm = Math.sqrt(
    Array.from(traceAnalysis.meanState).reduce((s, v) => s + v * v, 0),
  );
  if (stateNorm < 0.1) {
    observations.push('WARNING: mean hidden state near zero - possible degenerate representations');
  }

  return `Reflection on strategy:\n${observations.map((o) => `- ${o}`).join('\n')}`;
}

// ── Curator ────────────────────────────────────────────────────────

/**
 * Curate: decide whether to accept, refine, or reject a strategy.
 * Scoring based on trace quality metrics.
 */
export function curate(
  generatorOutput: string,
  reflectorAnalysis: string,
  traceAnalysis: ReturnType<typeof analyzeTracesForReflection>,
): { verdict: 'accept' | 'refine' | 'reject'; score: number } {
  let score = 0.5;

  // Convergence quality bonus
  if (traceAnalysis.convergenceTrajectory.length > 0) {
    const finalDelta = traceAnalysis.convergenceTrajectory.at(-1)?.delta ?? 1;
    if (finalDelta < 0.02) score += 0.2;
    else if (finalDelta < 0.1) score += 0.1;
    else score -= 0.1;
  }

  // Anomaly penalty
  score -= traceAnalysis.anomalies.length * 0.05;

  // Reflector warnings penalty
  const warnings = (reflectorAnalysis.match(/WARNING/g) || []).length;
  score -= warnings * 0.1;

  // Strategy completeness bonus
  if (generatorOutput.length > 100) score += 0.05;
  if (generatorOutput.includes('anomal') || generatorOutput.includes('address')) score += 0.05;

  score = Math.max(0, Math.min(1, score));

  let verdict: 'accept' | 'refine' | 'reject';
  if (score >= 0.7) verdict = 'accept';
  else if (score >= 0.4) verdict = 'refine';
  else verdict = 'reject';

  return { verdict, score };
}

// ── AxACE Loop ─────────────────────────────────────────────────────

/** Max iterations per AxACE session */
const MAX_AXACE_ROUNDS = 5;

/**
 * Run the full AxACE loop for a task.
 * Generator -> Reflector -> Curator, repeat until accept or budget exhausted.
 *
 * Integration point 3: Reflector uses trace data instead of text.
 * Playbook entries store latent fingerprints from trace mean states.
 */
export function runAxACE(
  taskId: string,
  taskPattern: string,
  maxRounds: number = MAX_AXACE_ROUNDS,
): AxACEResult {
  logger.info({ taskId, taskPattern, maxRounds }, 'AxACE: starting loop');

  // Get trace analysis (recursion traces, not surface text)
  const traceAnalysis = analyzeTracesForReflection(taskId);

  // Check existing playbook for related strategies
  const existing = matchPlaybook(taskPattern, traceAnalysis.meanState);

  const iterations: AxACEIteration[] = [];
  let acceptedEntry: PlaybookEntry | null = null;

  for (let round = 0; round < maxRounds; round++) {
    // Generator
    const generatorOutput = generate(taskPattern, traceAnalysis, existing);

    // Reflector (trace-based, not text-based)
    const reflectorAnalysis = reflect(generatorOutput, traceAnalysis);

    // Curator
    const { verdict, score } = curate(generatorOutput, reflectorAnalysis, traceAnalysis);

    const iteration: AxACEIteration = {
      round,
      generatorOutput,
      reflectorAnalysis,
      curatorVerdict: verdict,
      curatorScore: score,
      traceRefs: traceAnalysis.traceIds,
      latentSnapshot: new Float32Array(traceAnalysis.meanState),
    };
    iterations.push(iteration);

    logger.debug({ round, verdict, score: score.toFixed(3) }, 'AxACE: iteration complete');

    if (verdict === 'accept') {
      // Create playbook entry
      acceptedEntry = {
        id: crypto.randomUUID(),
        taskPattern,
        strategy: generatorOutput,
        latentFingerprint: new Float32Array(traceAnalysis.meanState),
        sourceTraceIds: traceAnalysis.traceIds,
        curatorScore: score,
        applicationCount: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };

      // Persist to playbook
      upsertPlaybookEntry(acceptedEntry);
      logger.info({ entryId: acceptedEntry.id, score: score.toFixed(3) }, 'AxACE: strategy accepted, playbook updated');
      break;
    }

    if (verdict === 'reject' && round >= maxRounds - 1) {
      logger.warn({ taskPattern, rounds: round + 1 }, 'AxACE: all iterations rejected');
    }
    // If 'refine', loop continues with updated context
  }

  const result: AxACEResult = {
    taskId,
    iterations,
    acceptedEntry,
    converged: acceptedEntry !== null,
    roundsExecuted: iterations.length,
  };

  logger.info(
    {
      taskId,
      converged: result.converged,
      rounds: result.roundsExecuted,
      playbook: acceptedEntry?.id ?? 'none',
    },
    'AxACE: loop complete',
  );

  return result;
}

// ── Playbook Stats ─────────────────────────────────────────────────

/**
 * Get playbook statistics for monitoring.
 */
export function getPlaybookStats(): {
  totalEntries: number;
  version: number;
  avgScore: number;
  topPatterns: string[];
} {
  const stored = loadPlaybook();
  const entries = Object.values(stored.entries);

  const avgScore = entries.length > 0
    ? entries.reduce((s, e) => s + e.curatorScore, 0) / entries.length
    : 0;

  const topPatterns = entries
    .sort((a, b) => b.curatorScore - a.curatorScore)
    .slice(0, 5)
    .map((e) => e.taskPattern);

  return {
    totalEntries: entries.length,
    version: stored.version,
    avgScore,
    topPatterns,
  };
}
