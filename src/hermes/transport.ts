/**
 * Hermes Layer 4 - Outer Link Transport
 *
 * Routes messages between agents using text, latent vectors, or both.
 * This is the gate module: nothing in L1-L6 advances until this is live.
 *
 * Architecture:
 *   1. Sender creates HermesMessage (text, latent, or dual)
 *   2. Transport checks route compatibility via registry
 *   3. Latent payloads serialized/deserialized through Float32 codec
 *   4. Every exchange logged to trace system
 *   5. Convergence checked after each round
 *
 * Backward compat: text-only messages pass through unchanged.
 * Agents that haven't registered latent caps get text routing automatically.
 */

import crypto from 'crypto';

import { logger } from '../logger.js';

import { checkRoute, getCapability } from './registry.js';
import { logTransportEvent, traceFromMessage, writeTrace } from './trace.js';
import { encodeFloat32, decodeFloat32 } from './trace.js';
import type {
  HermesMessage,
  LatentPayload,
  MessageMode,
  TransportEvent,
  TransportEventHandler,
  LATENT_DIM,
} from './types.js';

// ── Convergence ─────────────────────────────────────────────────────

/** Locked convergence threshold: cosine_sim delta < 0.02 */
const CONVERGENCE_THRESHOLD = 0.02;

/** Compute cosine similarity between two Float32Arrays. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
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

/**
 * Check if latent representations have converged between rounds.
 * Returns the delta (1 - cosine_sim). Converged when delta < threshold.
 */
export function checkConvergence(
  prev: Float32Array,
  curr: Float32Array,
): { converged: boolean; delta: number } {
  const sim = cosineSimilarity(prev, curr);
  const delta = 1 - sim;
  return {
    converged: delta < CONVERGENCE_THRESHOLD,
    delta,
  };
}

// ── Latent Serialization ────────────────────────────────────────────

export interface SerializedLatent {
  data: string; // base64
  numVectors: number;
  dim: number;
  adapterKey: string;
  sourceHiddenSize: number;
}

/** Serialize LatentPayload to JSON-safe format. */
export function serializeLatent(payload: LatentPayload): SerializedLatent {
  return {
    data: encodeFloat32(payload.data),
    numVectors: payload.numVectors,
    dim: payload.dim,
    adapterKey: payload.adapterKey,
    sourceHiddenSize: payload.sourceHiddenSize,
  };
}

/** Deserialize back to LatentPayload. */
export function deserializeLatent(stored: SerializedLatent): LatentPayload {
  return {
    data: decodeFloat32(stored.data),
    numVectors: stored.numVectors,
    dim: stored.dim,
    adapterKey: stored.adapterKey,
    sourceHiddenSize: stored.sourceHiddenSize,
  };
}

// ── Message Construction ────────────────────────────────────────────

/** Create a text-only HermesMessage (backward compat path). */
export function createTextMessage(opts: {
  fromAgent: string;
  toAgent: string;
  chatId: string;
  text: string;
  taskId: string;
  round?: number;
  parentTraceId?: string;
}): HermesMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    chatId: opts.chatId,
    mode: 'text',
    text: opts.text,
    taskId: opts.taskId,
    round: opts.round ?? 0,
    convergenceDelta: null,
    parentTraceId: opts.parentTraceId,
  };
}

/** Create a latent-only HermesMessage. */
export function createLatentMessage(opts: {
  fromAgent: string;
  toAgent: string;
  chatId: string;
  latent: LatentPayload;
  taskId: string;
  round: number;
  convergenceDelta: number | null;
  parentTraceId?: string;
}): HermesMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    chatId: opts.chatId,
    mode: 'latent',
    latent: opts.latent,
    taskId: opts.taskId,
    round: opts.round,
    convergenceDelta: opts.convergenceDelta,
    parentTraceId: opts.parentTraceId,
  };
}

/** Create a dual-mode HermesMessage (text + latent). */
export function createDualMessage(opts: {
  fromAgent: string;
  toAgent: string;
  chatId: string;
  text: string;
  latent: LatentPayload;
  taskId: string;
  round: number;
  convergenceDelta: number | null;
  parentTraceId?: string;
}): HermesMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    chatId: opts.chatId,
    mode: 'dual',
    text: opts.text,
    latent: opts.latent,
    taskId: opts.taskId,
    round: opts.round,
    convergenceDelta: opts.convergenceDelta,
    parentTraceId: opts.parentTraceId,
  };
}

// ── Transport Layer ─────────────────────────────────────────────────

const eventHandlers: TransportEventHandler[] = [];

/** Subscribe to transport events (for monitoring/dashboard). */
export function onTransportEvent(handler: TransportEventHandler): () => void {
  eventHandlers.push(handler);
  return () => {
    const idx = eventHandlers.indexOf(handler);
    if (idx >= 0) eventHandlers.splice(idx, 1);
  };
}

function emitEvent(event: TransportEvent): void {
  logTransportEvent(event);
  for (const handler of eventHandlers) {
    try {
      handler(event);
    } catch (err) {
      logger.warn({ err }, 'Transport event handler error');
    }
  }
}

/**
 * Send a HermesMessage through the transport layer.
 *
 * Steps:
 *   1. Check route compatibility
 *   2. Downgrade mode if target can't handle it
 *   3. Log trace (if latent payload present)
 *   4. Emit transport events
 *   5. Return the (possibly downgraded) message
 *
 * This does NOT execute the target agent. It prepares the message
 * for the orchestrator to deliver. The orchestrator calls
 * delegateToAgent() with the message payload.
 */
export function sendMessage(msg: HermesMessage): HermesMessage {
  const route = checkRoute(msg.fromAgent, msg.toAgent);

  if (!route.compatible) {
    emitEvent({
      type: 'capability_mismatch',
      timestamp: new Date().toISOString(),
      messageId: msg.id,
      fromAgent: msg.fromAgent,
      toAgent: msg.toAgent,
      detail: route.reason,
    });
    logger.warn(
      { from: msg.fromAgent, to: msg.toAgent, reason: route.reason },
      'Hermes: route incompatible, falling back to text',
    );
    // Force text-only fallback
    return { ...msg, mode: 'text', latent: undefined };
  }

  // Downgrade if needed: sender has latent but receiver only takes text
  let deliveredMsg = msg;
  if (msg.mode === 'latent' && route.recommendedMode === 'text') {
    logger.info(
      { from: msg.fromAgent, to: msg.toAgent },
      'Hermes: downgrading latent to text (target text-only)',
    );
    deliveredMsg = { ...msg, mode: 'text', latent: undefined };
    emitEvent({
      type: 'message_dropped',
      timestamp: new Date().toISOString(),
      messageId: msg.id,
      fromAgent: msg.fromAgent,
      toAgent: msg.toAgent,
      detail: 'Latent payload dropped: target is text-only',
    });
  } else if (msg.mode === 'dual' && route.recommendedMode === 'text') {
    deliveredMsg = { ...msg, mode: 'text', latent: undefined };
  }

  // Log trace for latent payloads
  if (deliveredMsg.latent) {
    const trace = traceFromMessage(deliveredMsg, 'L4');
    if (trace) {
      writeTrace(trace);
    }
  }

  // Emit sent event
  emitEvent({
    type: 'message_sent',
    timestamp: new Date().toISOString(),
    messageId: deliveredMsg.id,
    fromAgent: deliveredMsg.fromAgent,
    toAgent: deliveredMsg.toAgent,
    detail: `mode=${deliveredMsg.mode}, round=${deliveredMsg.round}`,
  });

  return deliveredMsg;
}

/**
 * Process a received message on the target side.
 * Validates payload integrity and emits receive event.
 */
export function receiveMessage(msg: HermesMessage): HermesMessage {
  // Validate latent dimensions if present
  if (msg.latent) {
    const expectedLength = msg.latent.dim * msg.latent.numVectors;
    if (msg.latent.data.length !== expectedLength) {
      logger.error(
        {
          messageId: msg.id,
          expected: expectedLength,
          actual: msg.latent.data.length,
        },
        'Hermes: latent payload size mismatch',
      );
      emitEvent({
        type: 'message_dropped',
        timestamp: new Date().toISOString(),
        messageId: msg.id,
        fromAgent: msg.fromAgent,
        toAgent: msg.toAgent,
        detail: `Latent size mismatch: expected ${expectedLength}, got ${msg.latent.data.length}`,
      });
      // Strip corrupted latent, fall back to text if available
      if (msg.text) {
        return { ...msg, mode: 'text', latent: undefined };
      }
      throw new Error(`Corrupted latent payload in message ${msg.id}`);
    }
  }

  emitEvent({
    type: 'message_received',
    timestamp: new Date().toISOString(),
    messageId: msg.id,
    fromAgent: msg.fromAgent,
    toAgent: msg.toAgent,
    detail: `mode=${msg.mode}`,
  });

  return msg;
}

// ── Round Management ────────────────────────────────────────────────

/** Per-layer round budgets (locked decision). */
export const ROUND_BUDGETS: Record<string, number> = {
  L1: 1,  // GitNexus: single pass
  L2: 1,  // DeepSec: single scan
  L3: 2,  // Borg Arc: absorb + validate
  L4: 3,  // Hermes: matches RecursiveMAS default recursive_rounds
  L5: 2,  // Ax: optimize + verify
  L6: 1,  // Borg Queen: orchestrate
};

/**
 * Track convergence across rounds for a task.
 * Returns whether to continue or stop iterating.
 */
export class ConvergenceTracker {
  private prevStates = new Map<string, Float32Array>();

  /**
   * Update with new state. Returns convergence info.
   * Key = agentId or any unique identifier for the tracked entity.
   */
  update(key: string, state: Float32Array): { converged: boolean; delta: number | null } {
    const prev = this.prevStates.get(key);
    if (!prev) {
      this.prevStates.set(key, new Float32Array(state));
      return { converged: false, delta: null };
    }
    const result = checkConvergence(prev, state);
    this.prevStates.set(key, new Float32Array(state));
    return result;
  }

  /** Check if all tracked entities have converged. */
  allConverged(): boolean {
    // Need at least one update before we can say "converged"
    return this.prevStates.size > 0;
    // Note: actual convergence is checked per-update via update()
    // This is a placeholder - full implementation needs round tracking
  }

  reset(): void {
    this.prevStates.clear();
  }
}
