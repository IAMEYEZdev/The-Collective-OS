/**
 * Hermes Layer 4 - Core Types
 *
 * Latent vector transport types for RecursiveMAS integration.
 * Locked decisions:
 *   - dim = 768
 *   - convergence = cosine_sim delta < 0.02
 *   - dual-mode backward compat mandatory
 */

// ── Latent Payload ──────────────────────────────────────────────────

/** Standard latent dimension across all layers. Locked. */
export const LATENT_DIM = 768;

/** A serialized latent vector payload for cross-agent transfer. */
export interface LatentPayload {
  /** Raw float32 data, length = dim * numVectors */
  data: Float32Array;
  /** Number of latent vectors (e.g. latent_length from rollout) */
  numVectors: number;
  /** Dimensionality per vector. Must equal LATENT_DIM. */
  dim: number;
  /** Which adapter produced this (inner or outer key) */
  adapterKey: string;
  /** Source agent hidden size before projection */
  sourceHiddenSize: number;
}

// ── Message Types ───────────────────────────────────────────────────

export type MessageMode = 'text' | 'latent' | 'dual';

/**
 * The unified Hermes message. Backward compatible: text-only messages
 * work exactly as before. Latent payloads ride alongside or replace text.
 */
export interface HermesMessage {
  /** Unique message ID */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Source agent ID */
  fromAgent: string;
  /** Target agent ID */
  toAgent: string;
  /** Telegram chat ID (routing context) */
  chatId: string;
  /** What this message carries */
  mode: MessageMode;
  /** Text payload (always present in 'text' and 'dual' mode) */
  text?: string;
  /** Latent vector payload (present in 'latent' and 'dual' mode) */
  latent?: LatentPayload;
  /** Task context */
  taskId: string;
  /** Which recursive round produced this (0 = non-recursive) */
  round: number;
  /** Convergence delta from previous round (null if round 0) */
  convergenceDelta: number | null;
  /** Parent trace ID for chaining */
  parentTraceId?: string;
}

// ── Agent Capabilities ──────────────────────────────────────────────

/** What message modes an agent can accept. */
export interface AgentCapability {
  agentId: string;
  /** What the agent can receive */
  accepts: MessageMode[];
  /** What the agent can produce */
  produces: MessageMode[];
  /** Agent's native hidden size (for dim validation) */
  hiddenSize?: number;
}

// ── Trace Schema ────────────────────────────────────────────────────
// Locked schema from pre-implementation decisions.

export interface TraceEntry {
  /** Which agent produced this state */
  agentId: string;
  /** Which layer: L1-L6 */
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  /** Recursive round index */
  round: number;
  /** The hidden state vector (serialized as Float32Array) */
  hiddenState: Float32Array;
  /** Convergence delta from previous round */
  convergenceDelta: number | null;
  /** Trace metadata */
  metadata: {
    dim: number;
    timestamp: string;
    taskId: string;
    parentTraceId?: string;
  };
}

// ── Transport Events ────────────────────────────────────────────────

export type TransportEventType =
  | 'message_sent'
  | 'message_received'
  | 'message_dropped'
  | 'convergence_reached'
  | 'round_complete'
  | 'capability_mismatch';

export interface TransportEvent {
  type: TransportEventType;
  timestamp: string;
  messageId: string;
  fromAgent: string;
  toAgent: string;
  detail?: string;
}

export type TransportEventHandler = (event: TransportEvent) => void;
