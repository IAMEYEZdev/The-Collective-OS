/**
 * Hermes Layer 4 - Latent Skill File Writer (Step 4 of 7)
 *
 * Writes mean hidden state vectors alongside text summaries into skill files.
 * Consumes ReflectionSkillSummary from summarizeForSkillFile() (Step 3).
 *
 * Skill files are dual-mode: text-only readers see JSON with human-readable
 * fields. Latent-aware readers also get the base64-encoded mean hidden state
 * vector for direct vector comparison / retrieval.
 *
 * Storage: store/hermes-skills/<taskId>.json
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';

import { LATENT_DIM } from './types.js';
import { encodeFloat32, decodeFloat32 } from './trace.js';

import type { ReflectionSkillSummary } from './reflective-phase.js';

// ── Storage ─────────────────────────────────────────────────────────

const SKILL_DIR = path.join(PROJECT_ROOT, 'store', 'hermes-skills');

/** Ensure skill directory exists. */
function ensureSkillDir(): void {
  if (!fs.existsSync(SKILL_DIR)) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
  }
}

// ── Types ───────────────────────────────────────────────────────────

/** On-disk format for a latent skill file. JSON-serializable. */
export interface LatentSkillFile {
  /** Schema version for forward compat */
  version: 1;
  /** Unique skill file ID */
  id: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
  /** Task that produced this skill */
  taskId: string;
  /** Agent that ran the reflection */
  reflectorAgentId: string;

  // ── Text-mode fields (backward compat) ──
  /** Human-readable summary of what reflection found */
  textSummary: string;
  /** Reflection depth used */
  depth: string;
  /** Number of reflection rounds executed */
  roundsExecuted: number;
  /** Whether reflection converged */
  converged: boolean;
  /** Final convergence delta (null if no delta) */
  finalDelta: number | null;
  /** Count of anomalies detected */
  anomalyCount: number;
  /** Types of anomalies found */
  anomalyTypes: string[];
  /** Types of actions recommended */
  actionTypes: string[];

  // ── Latent-mode fields ──
  /** Base64-encoded Float32Array mean hidden state vector */
  latentState: string;
  /** Dimensionality of latent vector (should equal LATENT_DIM=768) */
  latentDim: number;
  /** Encoding format marker */
  latentEncoding: 'float32-base64';
}

/** Options for writing a skill file. */
export interface WriteSkillFileOptions {
  /** ReflectionSkillSummary from summarizeForSkillFile() */
  summary: ReflectionSkillSummary;
  /** Optional human-readable text summary. Auto-generated if omitted. */
  textSummary?: string;
}

/** Result of reading a skill file. */
export interface SkillFileReadResult {
  /** Parsed skill file */
  file: LatentSkillFile;
  /** Decoded mean hidden state vector (convenience) */
  meanHiddenState: Float32Array;
}

// ── Text Summary Generation ─────────────────────────────────────────

/** Generate a human-readable text summary from reflection data. */
function generateTextSummary(summary: ReflectionSkillSummary): string {
  const parts: string[] = [];

  parts.push(
    `Reflection on task "${summary.taskId}" by ${summary.reflectorAgentId}.`
  );
  parts.push(
    `Depth: ${summary.depth}, rounds: ${summary.roundsExecuted}.`
  );

  if (summary.converged) {
    parts.push(`Converged (delta=${summary.finalDelta?.toFixed(4) ?? 'n/a'}).`);
  } else {
    parts.push(`Did not converge (delta=${summary.finalDelta?.toFixed(4) ?? 'n/a'}).`);
  }

  if (summary.anomalyCount > 0) {
    parts.push(
      `${summary.anomalyCount} anomalies detected: ${summary.anomalyTypes.join(', ')}.`
    );
  } else {
    parts.push('No anomalies detected.');
  }

  if (summary.actionTypes.length > 0) {
    parts.push(`Recommended actions: ${summary.actionTypes.join(', ')}.`);
  }

  return parts.join(' ');
}

// ── Write ───────────────────────────────────────────────────────────

/**
 * Write a latent skill file from a ReflectionSkillSummary.
 *
 * If a skill file already exists for the taskId, it is overwritten
 * (updatedAt timestamp changes, id stays).
 */
export function writeSkillFile(opts: WriteSkillFileOptions): LatentSkillFile {
  ensureSkillDir();

  const { summary, textSummary } = opts;
  const filePath = path.join(SKILL_DIR, `${summary.taskId}.json`);
  const now = new Date().toISOString();

  // Preserve existing ID if updating
  let existingId: string | null = null;
  let createdAt = now;
  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LatentSkillFile;
      existingId = existing.id;
      createdAt = existing.createdAt;
    } catch {
      // Corrupt file, overwrite entirely
    }
  }

  // Validate dimension
  if (summary.meanHiddenState.length !== LATENT_DIM) {
    logger.warn(
      { expected: LATENT_DIM, got: summary.meanHiddenState.length, taskId: summary.taskId },
      'Skill file: dimension mismatch in mean hidden state'
    );
  }

  const skillFile: LatentSkillFile = {
    version: 1,
    id: existingId ?? crypto.randomUUID(),
    createdAt,
    updatedAt: now,
    taskId: summary.taskId,
    reflectorAgentId: summary.reflectorAgentId,

    // Text-mode
    textSummary: textSummary ?? generateTextSummary(summary),
    depth: summary.depth,
    roundsExecuted: summary.roundsExecuted,
    converged: summary.converged,
    finalDelta: summary.finalDelta,
    anomalyCount: summary.anomalyCount,
    anomalyTypes: summary.anomalyTypes,
    actionTypes: summary.actionTypes,

    // Latent-mode
    latentState: encodeFloat32(summary.meanHiddenState),
    latentDim: summary.meanHiddenState.length,
    latentEncoding: 'float32-base64',
  };

  fs.writeFileSync(filePath, JSON.stringify(skillFile, null, 2), 'utf-8');
  logger.debug(
    { skillId: skillFile.id, taskId: summary.taskId, dim: skillFile.latentDim },
    'Skill file written'
  );

  return skillFile;
}

// ── Read ────────────────────────────────────────────────────────────

/** Read a skill file by taskId. Returns null if not found. */
export function readSkillFile(taskId: string): SkillFileReadResult | null {
  const filePath = path.join(SKILL_DIR, `${taskId}.json`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const file = JSON.parse(raw) as LatentSkillFile;
  const meanHiddenState = decodeFloat32(file.latentState);

  return { file, meanHiddenState };
}

/** Read a skill file, returning only the text summary (backward compat). */
export function readSkillFileText(taskId: string): string | null {
  const result = readSkillFile(taskId);
  return result?.file.textSummary ?? null;
}

/** Read a skill file, returning the decoded latent vector. */
export function readSkillFileLatent(taskId: string): Float32Array | null {
  const result = readSkillFile(taskId);
  return result?.meanHiddenState ?? null;
}

// ── List / Query ────────────────────────────────────────────────────

/** List all skill file task IDs. */
export function listSkillFiles(): string[] {
  ensureSkillDir();
  return fs
    .readdirSync(SKILL_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/** Delete a skill file by taskId. Returns true if deleted. */
export function deleteSkillFile(taskId: string): boolean {
  const filePath = path.join(SKILL_DIR, `${taskId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Find skill files matching a filter predicate.
 * Reads all files - use sparingly on large stores.
 */
export function findSkillFiles(
  predicate: (file: LatentSkillFile) => boolean
): LatentSkillFile[] {
  const taskIds = listSkillFiles();
  const results: LatentSkillFile[] = [];
  for (const taskId of taskIds) {
    const result = readSkillFile(taskId);
    if (result && predicate(result.file)) {
      results.push(result.file);
    }
  }
  return results;
}

/**
 * Cosine similarity between two skill files' latent states.
 * Returns null if either file not found.
 */
export function skillFileSimilarity(taskIdA: string, taskIdB: string): number | null {
  const a = readSkillFileLatent(taskIdA);
  const b = readSkillFileLatent(taskIdB);
  if (!a || !b) return null;
  if (a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
