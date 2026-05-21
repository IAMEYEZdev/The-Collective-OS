/**
 * Hermes Layer 4 - Reflection Depth Mapping (Step 5 of 7)
 *
 * Maps task properties to reflection depth and provides the auto-reflection
 * hook that runs after delegation. Consumes inferReflectionDepth() from
 * reflective-phase.ts and wires it into the broader system.
 *
 * Task classification: examines agent ID, prompt content, and layer context
 * to determine security adjacency, risk level, and appropriate depth.
 */

import { logger } from '../logger.js';

import type { ReflectionDepth, ReflectionResult, ReflectionSkillSummary } from './reflective-phase.js';
import {
  inferReflectionDepth,
  runReflection,
  summarizeForSkillFile,
} from './reflective-phase.js';
import { writeSkillFile } from './skill-file.js';
import type { LatentSkillFile } from './skill-file.js';

// ── Task Classification ─────────────────────────────────────────────

/** Signals extracted from task context for depth inference. */
export interface TaskSignals {
  /** Target agent ID */
  agentId: string;
  /** Task prompt text */
  prompt: string;
  /** Which layer originated this (if known) */
  layer?: string;
  /** Explicit depth override (from caller) */
  explicitDepth?: ReflectionDepth;
}

/** Classification result from analyzing task signals. */
export interface TaskClassification {
  isSecurityAdjacent: boolean;
  isHighRisk: boolean;
  layer: string | undefined;
  inferredDepth: ReflectionDepth;
  /** Why this depth was chosen */
  reason: string;
}

// ── Security-adjacent patterns ──

const SECURITY_AGENT_IDS = new Set([
  'deepsec',
  'security',
  'sec',
  'audit',
  'pentester',
]);

const SECURITY_KEYWORDS = [
  'auth', 'authentication', 'authorization', 'authz',
  'credential', 'password', 'secret', 'token',
  'permission', 'access control', 'rbac', 'acl',
  'encrypt', 'decrypt', 'cipher', 'hash',
  'vulnerability', 'exploit', 'injection', 'xss', 'csrf',
  'certificate', 'tls', 'ssl', 'oauth',
  'firewall', 'security', 'breach', 'attack',
  'sanitize', 'validate input', 'escape',
];

// ── High-risk patterns ──

const HIGH_RISK_KEYWORDS = [
  'database migration', 'schema change', 'drop table', 'delete all',
  'production', 'deploy', 'rollback', 'downtime',
  'payment', 'billing', 'charge', 'refund', 'stripe',
  'user data', 'pii', 'gdpr', 'compliance',
  'infrastructure', 'terraform', 'kubernetes', 'cluster',
  'api key', 'env var', 'environment variable',
];

// ── Layer detection from agent IDs ──

const LAYER_AGENT_MAP: Record<string, string> = {
  gitnexus: 'L1',
  deepsec: 'L2',
  security: 'L2',
  'borg-arc': 'L3',
  borg: 'L3',
  hermes: 'L4',
  ax: 'L5',
  'borg-queen': 'L6',
};

/**
 * Classify a task to determine reflection depth signals.
 *
 * Checks agent ID, prompt content, and layer context against known
 * patterns. Returns classification with reason for audit trail.
 */
export function classifyTask(signals: TaskSignals): TaskClassification {
  const agentLower = signals.agentId.toLowerCase();
  const promptLower = signals.prompt.toLowerCase();

  // Security adjacency: agent is security-focused OR prompt contains security keywords
  const isSecurityAgent = SECURITY_AGENT_IDS.has(agentLower);
  const hasSecurityKeywords = SECURITY_KEYWORDS.some((kw) => promptLower.includes(kw));
  const isSecurityAdjacent = isSecurityAgent || hasSecurityKeywords;

  // High risk: prompt contains high-risk patterns
  const isHighRisk = HIGH_RISK_KEYWORDS.some((kw) => promptLower.includes(kw));

  // Layer detection: explicit > agent ID mapping
  const layer = signals.layer ?? LAYER_AGENT_MAP[agentLower];

  // Infer depth using existing function
  const inferredDepth = inferReflectionDepth({
    layer,
    isSecurityAdjacent,
    isHighRisk,
    explicit: signals.explicitDepth,
  });

  // Build reason string
  const reasons: string[] = [];
  if (signals.explicitDepth) {
    reasons.push(`explicit=${signals.explicitDepth}`);
  }
  if (isSecurityAgent) {
    reasons.push(`security-agent=${agentLower}`);
  }
  if (hasSecurityKeywords) {
    const matched = SECURITY_KEYWORDS.filter((kw) => promptLower.includes(kw));
    reasons.push(`security-keywords=[${matched.slice(0, 3).join(',')}]`);
  }
  if (isHighRisk) {
    const matched = HIGH_RISK_KEYWORDS.filter((kw) => promptLower.includes(kw));
    reasons.push(`high-risk=[${matched.slice(0, 3).join(',')}]`);
  }
  if (layer) {
    reasons.push(`layer=${layer}`);
  }
  if (reasons.length === 0) {
    reasons.push('default');
  }

  return {
    isSecurityAdjacent,
    isHighRisk,
    layer,
    inferredDepth,
    reason: reasons.join('; '),
  };
}

// ── Auto-Reflection Hook ────────────────────────────────────────────

/** Result of an auto-reflection run. */
export interface AutoReflectionResult {
  /** Whether reflection was triggered */
  triggered: boolean;
  /** Why it was or wasn't triggered */
  reason: string;
  /** Task classification used */
  classification: TaskClassification;
  /** Reflection result (if triggered) */
  reflection?: ReflectionResult;
  /** Skill file written (if reflection produced one) */
  skillFile?: LatentSkillFile;
}

/** Options for auto-reflection. */
export interface AutoReflectionOptions {
  /** Task ID (from delegation) */
  taskId: string;
  /** Agent that was delegated to */
  agentId: string;
  /** Original prompt */
  prompt: string;
  /** Layer context (if known) */
  layer?: string;
  /** Explicit depth override */
  explicitDepth?: ReflectionDepth;
  /** Whether to write skill file from reflection result */
  writeSkill?: boolean;
  /** Minimum depth threshold to trigger reflection. Default: 'light' (always trigger) */
  minDepthToTrigger?: ReflectionDepth;
}

/** Depth ordering for threshold comparison. */
const DEPTH_ORDER: Record<ReflectionDepth, number> = {
  light: 0,
  standard: 1,
  deep: 2,
};

/**
 * Auto-reflection hook for post-delegation.
 *
 * Classifies task, infers depth, runs reflection if depth meets threshold,
 * optionally writes skill file. Returns full result for orchestrator logging.
 *
 * Usage in orchestrator:
 *   const delegation = await delegateToAgent(...);
 *   const autoReflect = autoReflect({ taskId: delegation.taskId, agentId, prompt });
 */
export function autoReflect(opts: AutoReflectionOptions): AutoReflectionResult {
  const classification = classifyTask({
    agentId: opts.agentId,
    prompt: opts.prompt,
    layer: opts.layer,
    explicitDepth: opts.explicitDepth,
  });

  const minDepth = opts.minDepthToTrigger ?? 'light';
  const shouldTrigger = DEPTH_ORDER[classification.inferredDepth] >= DEPTH_ORDER[minDepth];

  if (!shouldTrigger) {
    return {
      triggered: false,
      reason: `depth=${classification.inferredDepth} below threshold=${minDepth}`,
      classification,
    };
  }

  logger.debug(
    {
      taskId: opts.taskId,
      depth: classification.inferredDepth,
      reason: classification.reason,
    },
    'Auto-reflection triggered'
  );

  const reflection = runReflection({
    taskId: opts.taskId,
    reflectorAgentId: `auto-reflector-${opts.agentId}`,
    depth: classification.inferredDepth,
  });

  let skillFile: LatentSkillFile | undefined;
  if (opts.writeSkill !== false) {
    const summary = summarizeForSkillFile(reflection);
    skillFile = writeSkillFile({ summary });
  }

  return {
    triggered: true,
    reason: classification.reason,
    classification,
    reflection,
    skillFile,
  };
}

// ── Batch Depth Query ───────────────────────────────────────────────

/**
 * Classify multiple tasks and return depth map.
 * Useful for planning reflection across a batch of delegations.
 */
export function batchClassify(
  tasks: Array<{ taskId: string; agentId: string; prompt: string; layer?: string }>
): Map<string, TaskClassification> {
  const result = new Map<string, TaskClassification>();
  for (const task of tasks) {
    result.set(task.taskId, classifyTask({
      agentId: task.agentId,
      prompt: task.prompt,
      layer: task.layer,
    }));
  }
  return result;
}
