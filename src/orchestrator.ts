import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { runAgent, UsageInfo } from './agent.js';
import { loadAgentConfig, listAgentIds, resolveAgentClaudeMd } from './agent-config.js';
import { PROJECT_ROOT } from './config.js';
import { logToHiveMind, createInterAgentTask, completeInterAgentTask } from './db.js';
import {
  createTextMessage,
  sendMessage,
  receiveMessage,
  registerAgent,
  autoReflect,
} from './hermes/index.js';
import type { HermesMessage, LatentPayload, AutoReflectionResult } from './hermes/index.js';
import {
  discover,
  matchPlaybook,
  getCompiledPrompt,
  runAxACE,
} from './ax/index.js';
import type {
  ReasoningStructure,
  StructureInitializer,
  DepthOverride,
  AxACEResult,
  PlaybookEntry,
  CompiledPrompt,
} from './ax/index.js';
import { logger } from './logger.js';
import { buildMemoryContext } from './memory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DelegationResult {
  agentId: string;
  text: string | null;
  usage: UsageInfo | null;
  taskId: string;
  durationMs: number;
  /** Hermes message metadata (present when routed through transport) */
  hermesMessage?: HermesMessage;
  /** Auto-reflection result (present when Hermes reflection ran post-delegation) */
  reflection?: AutoReflectionResult;
  /** L5 Ax: Self-Discover reasoning structure + depth override */
  axDiscovery?: {
    structure: ReasoningStructure;
    initializer: StructureInitializer;
    depthOverride: DepthOverride;
    cached: boolean;
  };
  /** L5 Ax: AxACE playbook result (present when post-delegation playbook loop ran) */
  axPlaybook?: AxACEResult;
  /** L5 Ax: matched playbook entries used to inform delegation */
  axPlaybookMatches?: PlaybookEntry[];
  /** L5 Ax: MiPRO compiled prompt if available for this task type */
  axCompiledPrompt?: CompiledPrompt;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// ── Registry ─────────────────────────────────────────────────────────

/** Cache of available agents loaded at startup. */
let agentRegistry: AgentInfo[] = [];

/** Default timeout for a delegated task (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the orchestrator by scanning `agents/` for valid configs.
 * Safe to call even if no agents are configured — the registry will be empty.
 */
export function initOrchestrator(): void {
  const ids = listAgentIds();
  agentRegistry = [];

  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      agentRegistry.push({
        id,
        name: config.name,
        description: config.description,
      });
    } catch (err) {
      // Agent config is broken (e.g. missing token) — skip it but warn
      logger.warn({ agentId: id, err }, 'Skipping agent — config load failed');
    }
  }

  // Register all agents with Hermes transport (text-only by default).
  // Agents upgraded with RecursiveMAS adapters will re-register with
  // latent capabilities when their adapters load.
  for (const agent of agentRegistry) {
    registerAgent({
      agentId: agent.id,
      accepts: ['text'],
      produces: ['text'],
    });
  }

  logger.info(
    { agents: agentRegistry.map((a) => a.id) },
    'Orchestrator initialized (Hermes transport active)',
  );
}

/** Return all agents that were successfully loaded. */
export function getAvailableAgents(): AgentInfo[] {
  return [...agentRegistry];
}

// ── Delegation ───────────────────────────────────────────────────────

/**
 * Parse a user message for delegation syntax.
 *
 * Supported forms:
 *   @agentId: prompt text
 *   @agentId prompt text   (only if agentId is a known agent)
 *   /delegate agentId prompt text
 *
 * Returns `{ agentId, prompt }` or `null` if no delegation detected.
 */
export function parseDelegation(
  message: string,
): { agentId: string; prompt: string } | null {
  // /delegate agentId prompt
  const cmdMatch = message.match(
    /^\/delegate\s+(\S+)\s+([\s\S]+)/i,
  );
  if (cmdMatch) {
    return { agentId: cmdMatch[1], prompt: cmdMatch[2].trim() };
  }

  // @agentId: prompt
  const atMatch = message.match(
    /^@(\S+?):\s*([\s\S]+)/,
  );
  if (atMatch) {
    return { agentId: atMatch[1], prompt: atMatch[2].trim() };
  }

  // @agentId prompt (only for known agents to avoid false positives)
  const atMatchNoColon = message.match(
    /^@(\S+)\s+([\s\S]+)/,
  );
  if (atMatchNoColon) {
    const candidate = atMatchNoColon[1];
    if (agentRegistry.some((a) => a.id === candidate)) {
      return { agentId: candidate, prompt: atMatchNoColon[2].trim() };
    }
  }

  return null;
}

/**
 * Delegate a task to another agent. Runs the agent's Claude Code session
 * in-process (same Node.js process) with the target agent's cwd and
 * system prompt.
 *
 * The delegation is logged to both `inter_agent_tasks` and `hive_mind`.
 *
 * @param agentId    Target agent identifier (must exist in agents/)
 * @param prompt     The task to delegate
 * @param chatId     Telegram chat ID (for DB tracking)
 * @param fromAgent  The requesting agent's ID (usually 'main')
 * @param onProgress Optional callback for status updates
 * @param timeoutMs  Maximum execution time (default 5 min)
 */
export async function delegateToAgent(
  agentId: string,
  prompt: string,
  chatId: string,
  fromAgent: string,
  onProgress?: (msg: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DelegationResult> {
  const agent = agentRegistry.find((a) => a.id === agentId);
  if (!agent) {
    const available = agentRegistry.map((a) => a.id).join(', ') || '(none)';
    throw new Error(
      `Agent "${agentId}" not found. Available: ${available}`,
    );
  }

  const taskId = crypto.randomUUID();
  const start = Date.now();

  // Record the task
  createInterAgentTask(taskId, fromAgent, agentId, chatId, prompt);
  logToHiveMind(
    fromAgent,
    chatId,
    'delegate',
    `Delegated to ${agentId}: ${prompt.slice(0, 100)}`,
  );

  onProgress?.(`Delegating to ${agent.name}...`);

  // ── Hermes transport: create and route message ──
  const hermesMsg = createTextMessage({
    fromAgent,
    toAgent: agentId,
    chatId,
    text: prompt,
    taskId,
  });
  const routed = sendMessage(hermesMsg);

  // ── L5 Ax: pre-delegation Self-Discover + MiPRO + playbook match ──
  let axDiscoveryResult: DelegationResult['axDiscovery'];
  let axPlaybookMatches: PlaybookEntry[] | undefined;
  let axCompiledPrompt: CompiledPrompt | undefined;
  let structuredPromptPrefix = '';

  try {
    // Self-Discover: classify task, compose reasoning structure, get depth override
    const disc = discover(taskId, agentId, prompt);
    axDiscoveryResult = {
      structure: disc.structure,
      initializer: disc.initializer,
      depthOverride: disc.depthOverride,
      cached: disc.cached,
    };
    structuredPromptPrefix = disc.prompt;

    logger.info(
      {
        taskId,
        agentId,
        complexity: disc.structure.complexity,
        modules: disc.structure.modules.length,
        depthRounds: disc.depthOverride.rounds,
        cached: disc.cached,
      },
      'L5 Self-Discover: task classified',
    );

    // MiPRO: check for compiled prompt optimized for this agent/task type
    const compiled = getCompiledPrompt(agentId);
    if (compiled) {
      axCompiledPrompt = compiled;
      logger.info(
        { taskId, agentId, promptId: compiled.id },
        'L5 MiPRO: compiled prompt found',
      );
    }

    // AxACE playbook: check for existing strategies matching this task
    const matches = matchPlaybook(agentId);
    if (matches.length > 0) {
      axPlaybookMatches = matches;
      logger.info(
        { taskId, agentId, matchCount: matches.length },
        'L5 AxACE: playbook matches found',
      );
    }
  } catch (axErr) {
    // L5 failure must never block delegation
    logger.warn({ taskId, agentId, err: axErr }, 'L5 Ax pre-delegation failed (non-fatal)');
  }

  try {
    // Load agent config to get its system prompt and MCP allowlist
    const agentConfig = loadAgentConfig(agentId);
    const claudeMdPath = resolveAgentClaudeMd(agentId);
    let systemPrompt = '';
    if (claudeMdPath) {
      try {
        systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
      } catch {
        // No CLAUDE.md for this agent -- that's fine
      }
    }

    // Build memory context for the delegated agent
    const { contextText: memCtx } = await buildMemoryContext(chatId, prompt, agentId);

    // Build the delegated prompt with agent role context + memory
    const contextParts: string[] = [];
    if (systemPrompt) {
      contextParts.push(`[Agent role -- follow these instructions]\n${systemPrompt}\n[End agent role]`);
    }
    if (memCtx) {
      contextParts.push(memCtx);
    }
    // L5 Ax: inject structured reasoning prompt if Self-Discover produced one
    if (structuredPromptPrefix) {
      contextParts.push(`[Reasoning Structure]\n${structuredPromptPrefix}\n[End Reasoning Structure]`);
    }
    // L5 Ax: inject playbook strategies if matched
    if (axPlaybookMatches && axPlaybookMatches.length > 0) {
      const strategies = axPlaybookMatches
        .map((e) => `- [${e.taskPattern}] (score: ${e.curatorScore.toFixed(2)}): ${e.strategy}`)
        .join('\n');
      contextParts.push(`[Proven Strategies]\n${strategies}\n[End Proven Strategies]`);
    }
    // Use routed message text (Hermes may have transformed it)
    contextParts.push(routed.text ?? prompt);
    const fullPrompt = contextParts.join('\n\n');

    // Create an AbortController with timeout
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

    try {
      const result = await runAgent(
        fullPrompt,
        undefined, // fresh session for each delegation
        () => {}, // no typing indicator needed for sub-delegation
        undefined, // no progress callback for inner agent
        undefined, // use default model
        abortCtrl,
        undefined, // no streaming for delegation
        agentConfig.mcpServers,
      );

      clearTimeout(timer);

      // Mark message received on target side
      receiveMessage(routed);

      const durationMs = Date.now() - start;
      completeInterAgentTask(taskId, 'completed', result.text);
      logToHiveMind(
        agentId,
        chatId,
        'delegate_result',
        `Completed delegation from ${fromAgent}: ${(result.text ?? '').slice(0, 120)}`,
      );

      onProgress?.(
        `${agent.name} completed (${Math.round(durationMs / 1000)}s)`,
      );

      // ── Hermes auto-reflection: classify task and reflect if warranted ──
      let reflectionResult: AutoReflectionResult | undefined;
      try {
        reflectionResult = autoReflect({
          taskId,
          agentId,
          prompt,
          writeSkill: true,
          // Only trigger reflection for standard+ depth tasks to avoid
          // overhead on simple delegations. Light tasks skip reflection.
          minDepthToTrigger: 'standard',
        });
        if (reflectionResult.triggered) {
          logger.info(
            {
              taskId,
              agentId,
              depth: reflectionResult.classification.inferredDepth,
              converged: reflectionResult.reflection?.reflectionConverged,
              reason: reflectionResult.reason,
            },
            'Post-delegation reflection completed',
          );
        }
      } catch (reflectErr) {
        // Reflection failure must never break delegation flow
        logger.warn({ taskId, agentId, err: reflectErr }, 'Auto-reflection failed (non-fatal)');
      }

      // ── L5 Ax: post-delegation AxACE playbook loop ──
      let axPlaybookResult: AxACEResult | undefined;
      try {
        const depthRounds = axDiscoveryResult?.depthOverride.rounds ?? 3;
        axPlaybookResult = runAxACE(taskId, agentId, depthRounds);
        if (axPlaybookResult.acceptedEntry) {
          logger.info(
            {
              taskId,
              agentId,
              entryId: axPlaybookResult.acceptedEntry.id,
              score: axPlaybookResult.acceptedEntry.curatorScore,
              rounds: axPlaybookResult.roundsExecuted,
            },
            'L5 AxACE: new playbook entry accepted',
          );
        }
      } catch (aceErr) {
        // AxACE failure must never break delegation flow
        logger.warn({ taskId, agentId, err: aceErr }, 'L5 AxACE post-delegation failed (non-fatal)');
      }

      return {
        agentId,
        text: result.text,
        usage: result.usage,
        taskId,
        durationMs,
        hermesMessage: routed,
        reflection: reflectionResult,
        axDiscovery: axDiscoveryResult,
        axPlaybook: axPlaybookResult,
        axPlaybookMatches,
        axCompiledPrompt,
      };
    } catch (innerErr) {
      clearTimeout(timer);
      throw innerErr;
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    completeInterAgentTask(taskId, 'failed', errMsg);
    logToHiveMind(
      agentId,
      chatId,
      'delegate_error',
      `Delegation from ${fromAgent} failed: ${errMsg.slice(0, 120)}`,
    );
    throw err;
  }
}
