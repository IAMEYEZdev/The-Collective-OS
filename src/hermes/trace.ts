/**
 * Hermes Layer 4 - Trace Logger
 *
 * Records every latent exchange with the locked trace schema.
 * Traces persist to disk (JSON lines) for L5 Ax consumption.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';

import type { TraceEntry, HermesMessage, TransportEvent } from './types.js';

// ── Storage ─────────────────────────────────────────────────────────

const TRACE_DIR = path.join(PROJECT_ROOT, 'store', 'hermes-traces');
const EVENT_LOG = path.join(TRACE_DIR, 'events.jsonl');

/** Ensure trace directory exists. Called once at init. */
function ensureTraceDir(): void {
  if (!fs.existsSync(TRACE_DIR)) {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
  }
}

// ── Serialization ───────────────────────────────────────────────────

/** Encode Float32Array to base64 for JSON storage. */
export function encodeFloat32(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

/** Decode base64 back to Float32Array. */
export function decodeFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ── Trace Operations ────────────────────────────────────────────────

export interface SerializedTrace {
  id: string;
  agentId: string;
  layer: string;
  round: number;
  hiddenState: string; // base64-encoded Float32Array
  convergenceDelta: number | null;
  metadata: {
    dim: number;
    timestamp: string;
    taskId: string;
    parentTraceId?: string;
  };
}

/** Convert a TraceEntry to its serialized (JSON-safe) form. */
export function serializeTrace(entry: TraceEntry): SerializedTrace {
  return {
    id: crypto.randomUUID(),
    agentId: entry.agentId,
    layer: entry.layer,
    round: entry.round,
    hiddenState: encodeFloat32(entry.hiddenState),
    convergenceDelta: entry.convergenceDelta,
    metadata: { ...entry.metadata },
  };
}

/** Deserialize a stored trace back to TraceEntry. */
export function deserializeTrace(stored: SerializedTrace): TraceEntry {
  return {
    agentId: stored.agentId,
    layer: stored.layer as TraceEntry['layer'],
    round: stored.round,
    hiddenState: decodeFloat32(stored.hiddenState),
    convergenceDelta: stored.convergenceDelta,
    metadata: { ...stored.metadata },
  };
}

/** Append a trace entry to the task-specific trace file. */
export function writeTrace(entry: TraceEntry): SerializedTrace {
  ensureTraceDir();
  const serialized = serializeTrace(entry);
  const taskFile = path.join(TRACE_DIR, `${entry.metadata.taskId}.jsonl`);
  fs.appendFileSync(taskFile, JSON.stringify(serialized) + '\n', 'utf-8');
  logger.debug({ traceId: serialized.id, agent: entry.agentId, round: entry.round }, 'Trace written');
  return serialized;
}

/** Read all traces for a given task. */
export function readTraces(taskId: string): SerializedTrace[] {
  const taskFile = path.join(TRACE_DIR, `${taskId}.jsonl`);
  if (!fs.existsSync(taskFile)) return [];
  const lines = fs.readFileSync(taskFile, 'utf-8').split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line) as SerializedTrace);
}

/** Extract a TraceEntry from a HermesMessage (for logging). */
export function traceFromMessage(msg: HermesMessage, layer: TraceEntry['layer']): TraceEntry | null {
  if (!msg.latent) return null;
  // Use first vector as representative hidden state for trace
  const vec = new Float32Array(msg.latent.dim);
  vec.set(msg.latent.data.subarray(0, msg.latent.dim));
  return {
    agentId: msg.fromAgent,
    layer,
    round: msg.round,
    hiddenState: vec,
    convergenceDelta: msg.convergenceDelta,
    metadata: {
      dim: msg.latent.dim,
      timestamp: msg.timestamp,
      taskId: msg.taskId,
      parentTraceId: msg.parentTraceId,
    },
  };
}

// ── Event Log ───────────────────────────────────────────────────────

/** Append a transport event to the global event log. */
export function logTransportEvent(event: TransportEvent): void {
  ensureTraceDir();
  fs.appendFileSync(EVENT_LOG, JSON.stringify(event) + '\n', 'utf-8');
}

/** Read recent transport events (last N). */
export function readRecentEvents(limit = 100): TransportEvent[] {
  if (!fs.existsSync(EVENT_LOG)) return [];
  const lines = fs.readFileSync(EVENT_LOG, 'utf-8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as TransportEvent);
}
