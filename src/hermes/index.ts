/**
 * Hermes Layer 4 - Public API
 *
 * The Outer Link transport layer for ClaudeClaw's multi-agent system.
 * Replaces text-only inter-agent messaging with latent vector transfer
 * while maintaining full backward compatibility.
 *
 * Usage:
 *   import { hermes } from './hermes/index.js';
 *   hermes.registerAgent({ agentId: 'ops', accepts: ['text', 'latent'], produces: ['text'] });
 *   const msg = hermes.createTextMessage({ ... });
 *   const delivered = hermes.sendMessage(msg);
 */

// Re-export types
export type {
  HermesMessage,
  LatentPayload,
  MessageMode,
  AgentCapability,
  TraceEntry,
  TransportEvent,
  TransportEventHandler,
  TransportEventType,
} from './types.js';

export { LATENT_DIM } from './types.js';

// Re-export registry
export {
  registerAgent,
  unregisterAgent,
  getCapability,
  listRegistered,
  checkRoute,
  validateDimensions,
  clearRegistry,
} from './registry.js';

// Re-export transport
export {
  createTextMessage,
  createLatentMessage,
  createDualMessage,
  sendMessage,
  receiveMessage,
  onTransportEvent,
  cosineSimilarity,
  checkConvergence,
  serializeLatent,
  deserializeLatent,
  ConvergenceTracker,
  ROUND_BUDGETS,
} from './transport.js';

// Re-export trace
export {
  writeTrace,
  readTraces,
  serializeTrace,
  deserializeTrace,
  traceFromMessage,
  encodeFloat32,
  decodeFloat32,
  readRecentEvents,
} from './trace.js';

// Re-export reflective phase
export type {
  ReflectionDepth,
  TraceAnalysis,
  AnomalyType,
  TraceAnomaly,
  ReflectionInput,
  ReflectionRound,
  ReflectionActionType,
  ReflectionAction,
  ReflectionResult,
  ReflectionSkillSummary,
} from './reflective-phase.js';

export {
  REFLECTION_ROUNDS,
  inferReflectionDepth,
  analyzeTraces,
  runReflection,
  summarizeForSkillFile,
} from './reflective-phase.js';

// Re-export skill file writer
export type {
  LatentSkillFile,
  WriteSkillFileOptions,
  SkillFileReadResult,
} from './skill-file.js';

export {
  writeSkillFile,
  readSkillFile,
  readSkillFileText,
  readSkillFileLatent,
  listSkillFiles,
  deleteSkillFile,
  findSkillFiles,
  skillFileSimilarity,
} from './skill-file.js';

// Re-export depth mapping
export type {
  TaskSignals,
  TaskClassification,
  AutoReflectionResult,
  AutoReflectionOptions,
} from './depth-map.js';

export {
  classifyTask,
  autoReflect,
  batchClassify,
} from './depth-map.js';

// ── Convenience namespace ───────────────────────────────────────────

import { registerAgent, unregisterAgent, getCapability, listRegistered, checkRoute, validateDimensions, clearRegistry } from './registry.js';
import { createTextMessage, createLatentMessage, createDualMessage, sendMessage, receiveMessage, onTransportEvent, cosineSimilarity, checkConvergence, ConvergenceTracker, ROUND_BUDGETS } from './transport.js';
import { writeTrace, readTraces, readRecentEvents } from './trace.js';
import { LATENT_DIM } from './types.js';
import { REFLECTION_ROUNDS, inferReflectionDepth, analyzeTraces, runReflection, summarizeForSkillFile } from './reflective-phase.js';
import { writeSkillFile, readSkillFile, readSkillFileText, readSkillFileLatent, listSkillFiles, deleteSkillFile, findSkillFiles, skillFileSimilarity } from './skill-file.js';
import { classifyTask, autoReflect, batchClassify } from './depth-map.js';

/** Namespace object for convenience imports. */
export const hermes = {
  // Constants
  LATENT_DIM,
  ROUND_BUDGETS,

  // Registry
  registerAgent,
  unregisterAgent,
  getCapability,
  listRegistered,
  checkRoute,
  validateDimensions,
  clearRegistry,

  // Transport
  createTextMessage,
  createLatentMessage,
  createDualMessage,
  sendMessage,
  receiveMessage,
  onTransportEvent,
  cosineSimilarity,
  checkConvergence,
  ConvergenceTracker,

  // Trace
  writeTrace,
  readTraces,
  readRecentEvents,

  // Reflective Phase
  REFLECTION_ROUNDS,
  inferReflectionDepth,
  analyzeTraces,
  runReflection,
  summarizeForSkillFile,

  // Skill File Writer
  writeSkillFile,
  readSkillFile,
  readSkillFileText,
  readSkillFileLatent,
  listSkillFiles,
  deleteSkillFile,
  findSkillFiles,
  skillFileSimilarity,

  // Depth Mapping
  classifyTask,
  autoReflect,
  batchClassify,
} as const;
