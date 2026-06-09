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
  computeCorrelations,
  executeAllFeedbackActions,
} from './hermes/index.js';
import type { HermesMessage, LatentPayload, AutoReflectionResult, CorrelationResult, FeedbackExecutionResult } from './hermes/index.js';
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
import {
  runGraphRecursion,
  getGraphRoundBudget,
  createLatentPayload as createGitNexusPayload,
  initAttentionFromAxWarmStart,
  createUniformAttention,
} from './gitnexus/latent-bridge.js';
import type { GraphLatentResult, InboundSignal } from './gitnexus/latent-bridge.js';
import { getSubgraph, analyzeImpact } from './gitnexus/query.js';
import { createDriver } from './gitnexus/ingest.js';
import {
  runScanRecursion,
  getScanRoundBudget,
  computeGateSignal,
  createBroadcastPayloads,
  createDeepSecPayload,
} from './deepsec/latent-bridge.js';
import type { ScanLatentResult, StructuralSignal, GateSignal } from './deepsec/latent-bridge.js';
import { scanDirectory } from './deepsec/scanner.js';
import { ALL_RULES } from './deepsec/rules.js';
import {
  planAcquisitionBatch,
  encodeIntentSignal,
  createBorgQueenReport,
  createBorgQueenPayload as createBorgArcQueenPayload,
} from './borg-arc/latent-bridge.js';
import type {
  AcquisitionThreadResult,
  BorgQueenReport,
  PreScreeningSignal,
} from './borg-arc/latent-bridge.js';
import { ClawCodeAdapter } from './borg-arc/adapters/claw-code-adapter.js';
import { ClawCodeRAGClient } from './borg-arc/adapters/claw-code-rag.js';
import { ClawCodeEventBridge } from './borg-arc/adapters/claw-code-events.js';
import type { ClawCodeConfig } from './borg-arc/adapters/claw-code-types.js';
import {
  initializeCluster,
  createClusterInitSignal,
  aggregateGlobalState,
  checkGlobalConvergence,
  createGlobalBroadcast,
  computeCreditAssignments,
  detectCapabilityGaps,
  gapsToBorgArcContext,
  createBorgQueenPayload,
} from './borg-queen/latent-bridge.js';
import type {
  ClusterConfig,
  ClusterResult,
  AgentRoundState,
  CapabilityGap,
} from './borg-queen/latent-bridge.js';
import { logger } from './logger.js';
import { buildMemoryContext } from './memory.js';

// -- Types ------------------------------------------------------------

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
  /** L1 GitNexus: structural latent analysis (present when graph available) */
  graphAnalysis?: GraphLatentResult;
  /** L2 DeepSec: security scan latent analysis (present when scan ran) */
  scanAnalysis?: ScanLatentResult;
  /** L2 DeepSec: gate signal (pass/fail/review) */
  securityGate?: GateSignal;
  /** L3 Borg Arc: acquisition batch report for Borg Queen (present when repos evaluated) */
  borgArcReport?: BorgQueenReport;
  /** L6 Borg Queen: cluster config used for orchestration (present when cluster ran) */
  borgQueenCluster?: ClusterConfig;
  /** L6 Borg Queen: capability gaps detected across recent clusters */
  capabilityGaps?: CapabilityGap[];
  /** L4 Cross-Agent Correlation: correlation result (present when feedback was injected) */
  crossAgentCorrelation?: CorrelationResult;
  /** L4 Cross-Agent Correlation: feedback execution results */
  feedbackResults?: FeedbackExecutionResult[];
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// -- Registry ---------------------------------------------------------

/** Cache of available agents loaded at startup. */
let agentRegistry: AgentInfo[] = [];

/** Default timeout for a delegated task (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the orchestrator by scanning `agents/` for valid configs.
 * Safe to call even if no agents are configured -- the registry will be empty.
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
      // Agent config is broken (e.g. missing token) -- skip it but warn
      logger.warn({ agentId: id, err }, 'Skipping agent -- config load failed');
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

  // Register Neo (cross-hemisphere engineering substrate via Codex CLI).
  // Neo communicates via file-bus dispatch envelopes, not direct Hermes transport,
  // but registration enables route checks, dimension validation, and credit
  // assignment when Neo agents participate in RecursiveMAS clusters.
  registerAgent({
    agentId: 'neo',
    accepts: ['text', 'latent'],
    produces: ['text', 'latent'],
  });

  // Claw-code binary configured - log readiness.
  // Full adapter wiring is deferred; enrichWithClawRAG handles RAG when a URL is set.
  if (process.env.CLAW_CODE_BIN) {
    logger.info(
      {
        binary: process.env.CLAW_CODE_BIN,
        model: process.env.CLAW_CODE_MODEL || 'sonnet',
        ragEnabled: !!process.env.CLAW_RAG_URL,
      },
      'Claw-code binary configured',
    );
  }

  logger.info(
    { agents: [...agentRegistry.map((a) => a.id), 'neo'] },
    'Orchestrator initialized (Hermes transport active, Neo registered)',
  );
}

/** Return all agents that were successfully loaded. */
export function getAvailableAgents(): AgentInfo[] {
  return [...agentRegistry];
}

/**
 * Enrich a prompt with RAG context from the claw-code semantic search service.
 * Returns the original prompt if RAG is unavailable or the query fails.
 */
export async function enrichWithClawRAG(prompt: string, ragUrl?: string): Promise<string> {
  if (!ragUrl) return prompt;
  try {
    const client = new ClawCodeRAGClient(ragUrl);
    const healthy = await client.health();
    if (!healthy) return prompt;
    const results = await client.query(prompt, 3);
    if (!results.length) return prompt;
    const context = results.map((r) => `[${r.source}]: ${r.text.slice(0, 300)}`).join('\n');
    return `[Claw-Code Context]\n${context}\n\n${prompt}`;
  } catch {
    return prompt;
  }
}

// -- Delegation -------------------------------------------------------

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

  // -- Hermes transport: create and route message --
  const hermesMsg = createTextMessage({
    fromAgent,
    toAgent: agentId,
    chatId,
    text: prompt,
    taskId,
  });
  const routed = sendMessage(hermesMsg);

  // -- L5 Ax: pre-delegation Self-Discover + MiPRO + playbook match --
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

  // -- L1 GitNexus: pre-delegation structural latent analysis --
  let graphAnalysisResult: GraphLatentResult | undefined;
  let l1InboundSignals: InboundSignal[] = [];

  try {
    const driver = createDriver();
    try {
      // Get subgraph for the agent's working directory
      const agentConfig = loadAgentConfig(agentId);
      const agentRoot = path.join(PROJECT_ROOT, 'agents', agentId);
      const subgraph = await getSubgraph(driver, agentRoot, 2);

      if (subgraph.nodes.length > 0) {
        // Get impact data for confidence scoring
        const impact = await analyzeImpact(driver, agentRoot);

        // Determine round budget from L5 complexity or default
        const complexity = axDiscoveryResult?.structure.complexity;
        const maxRounds = getGraphRoundBudget(complexity);

        // Initialize attention: use Ax warm-start if available, else uniform
        const initialAttention = axDiscoveryResult
          ? initAttentionFromAxWarmStart(subgraph, axDiscoveryResult.initializer.hiddenState)
          : createUniformAttention(subgraph);

        graphAnalysisResult = runGraphRecursion({
          taskId,
          subgraph,
          maxRounds,
          initialAttention,
          impact,
        });

        logger.info(
          {
            taskId,
            agentId,
            rounds: graphAnalysisResult.rounds.length,
            converged: graphAnalysisResult.converged,
            confidence: graphAnalysisResult.finalConfidence,
          },
          'L1 GitNexus: structural analysis complete',
        );
      }
    } finally {
      await driver.close();
    }
  } catch (l1Err) {
    // L1 failure must never block delegation (Neo4j may be down)
    logger.warn({ taskId, agentId, err: l1Err }, 'L1 GitNexus pre-delegation failed (non-fatal)');
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

      // -- Hermes auto-reflection: classify task and reflect if warranted --
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

      // -- L4 Cross-Agent Correlation: execute inject_feedback if reflection recommends it --
      let crossAgentCorrelation: CorrelationResult | undefined;
      let feedbackResults: FeedbackExecutionResult[] = [];
      try {
        if (reflectionResult?.triggered && reflectionResult.reflection?.finalActions) {
          const feedbackActions = reflectionResult.reflection.finalActions.filter(
            (a) => a.type === 'inject_feedback',
          );
          if (feedbackActions.length > 0) {
            crossAgentCorrelation = computeCorrelations(taskId);
            feedbackResults = executeAllFeedbackActions(taskId, feedbackActions);
            const succeeded = feedbackResults.filter((r) => r.success).length;
            if (succeeded > 0) {
              logger.info(
                { taskId, agentId, total: feedbackActions.length, succeeded },
                'Cross-agent feedback injected',
              );
            }
          }
        }
      } catch (corrErr) {
        logger.warn({ taskId, agentId, err: corrErr }, 'Cross-agent correlation failed (non-fatal)');
      }

      // -- L5 Ax: post-delegation AxACE playbook loop --
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

      // -- L2 DeepSec: post-delegation security scan latent analysis --
      let scanAnalysisResult: ScanLatentResult | undefined;
      let securityGateResult: GateSignal | undefined;

      try {
        // Run security scan on agent's working directory
        const scanRoot = path.join(PROJECT_ROOT, 'agents', agentId);
        const baseScanResult = scanDirectory(scanRoot, ALL_RULES);

        if (baseScanResult.findings.length > 0) {
          // Determine round budget
          const complexity = axDiscoveryResult?.structure.complexity;
          const hasHighSev = baseScanResult.findings.some(
            (f) => f.severity === 'critical' || f.severity === 'high',
          );
          const maxRounds = getScanRoundBudget(complexity, hasHighSev);

          // Build structural signals from L1 GitNexus if available
          const structuralSignals: StructuralSignal[] = [];
          if (graphAnalysisResult) {
            structuralSignals.push({
              fromAgent: 'gitnexus',
              signalType: 'graph_structure',
              hiddenState: graphAnalysisResult.finalState,
            });
          }

          scanAnalysisResult = runScanRecursion({
            taskId,
            baseScanResult,
            maxRounds,
            structuralSignals,
          });

          // Compute gate signal from final scan state
          securityGateResult = computeGateSignal(
            scanAnalysisResult.rounds[scanAnalysisResult.rounds.length - 1],
            scanAnalysisResult.totalUniqueFindings,
          );

          // Broadcast to downstream layers (Borg Arc, Borg Queen)
          const broadcastPayloads = createBroadcastPayloads(
            scanAnalysisResult.finalState,
            ['borgarc', 'borgqueen'],
          );

          logger.info(
            {
              taskId,
              agentId,
              rounds: scanAnalysisResult.rounds.length,
              converged: scanAnalysisResult.converged,
              findings: scanAnalysisResult.totalUniqueFindings,
              gate: securityGateResult.gate,
              broadcastTargets: Array.from(broadcastPayloads.keys()),
            },
            'L2 DeepSec: security scan analysis complete',
          );
        }
      } catch (l2Err) {
        // L2 failure must never block delegation
        logger.warn({ taskId, agentId, err: l2Err }, 'L2 DeepSec post-delegation failed (non-fatal)');
      }

      // -- L3 Borg Arc: post-delegation acquisition coordination --
      // If L1 and L2 signals are available, encode them for Borg Queen reporting.
      // Actual parallel acquisition threads run separately via planAcquisitionBatch.
      let borgArcReportResult: BorgQueenReport | undefined;
      try {
        if (graphAnalysisResult && scanAnalysisResult) {
          const intent = {
            priority: 'structural_compatibility' as const,
            targetLayer: 'L1' as const,
            riskTolerance: 'standard' as const,
          };

          // Create a report stub for the Borg Queen from available signals
          const threadResult: AcquisitionThreadResult = {
            threadId: `thread-${taskId}`,
            repoUrl: agentId,
            rounds: [],
            converged: scanAnalysisResult.converged,
            finalDecision: securityGateResult?.gate === 'fail' ? 'skip' : 'review',
            finalConfidence: securityGateResult?.confidence ?? 0.5,
            finalState: scanAnalysisResult.finalState,
            qualityTier: 'standard',
          };
          borgArcReportResult = createBorgQueenReport(threadResult, intent);
          logger.info(
            { taskId, agentId, decision: threadResult.finalDecision },
            'L3 Borg Arc: acquisition report generated for Borg Queen',
          );
        }
      } catch (l3Err) {
        logger.warn({ taskId, agentId, err: l3Err }, 'L3 Borg Arc post-delegation failed (non-fatal)');
      }

      // -- L6 Borg Queen: outer orchestrator cluster initialization --
      // Creates cluster config from available layer signals for future aggregation.
      let borgQueenClusterResult: ClusterConfig | undefined;
      let capabilityGapsResult: CapabilityGap[] | undefined;
      try {
        // Initialize a cluster config capturing this delegation's layer participants
        const activeParticipants: Array<{ agentId: string; layer: string; latentCapable?: boolean }> = [];
        if (graphAnalysisResult) activeParticipants.push({ agentId: 'gitnexus', layer: 'L1' });
        if (scanAnalysisResult) activeParticipants.push({ agentId: 'deepsec', layer: 'L2' });
        if (borgArcReportResult) activeParticipants.push({ agentId: 'borgarc', layer: 'L3' });

        if (activeParticipants.length > 0) {
          const complexity = axDiscoveryResult?.depthOverride?.complexity ?? 'moderate';
          borgQueenClusterResult = initializeCluster({
            taskId,
            participants: activeParticipants,
            complexity,
            playbookPrior: graphAnalysisResult?.finalState,
          });

          const initSignal = createClusterInitSignal(borgQueenClusterResult);
          logger.info(
            {
              taskId,
              agentId,
              clusterId: borgQueenClusterResult.clusterId,
              participants: activeParticipants.length,
              maxRounds: borgQueenClusterResult.maxRounds,
              initSignalDim: initSignal.length,
            },
            'L6 Borg Queen: cluster initialized for delegation',
          );
        }
      } catch (l6Err) {
        logger.warn({ taskId, agentId, err: l6Err }, 'L6 Borg Queen cluster init failed (non-fatal)');
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
        graphAnalysis: graphAnalysisResult,
        scanAnalysis: scanAnalysisResult,
        securityGate: securityGateResult,
        borgArcReport: borgArcReportResult,
        borgQueenCluster: borgQueenClusterResult,
        capabilityGaps: capabilityGapsResult,
        crossAgentCorrelation,
        feedbackResults,
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
