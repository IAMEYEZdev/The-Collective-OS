import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_MAX_TURNS, PROJECT_ROOT, agentCwd } from './config.js';
import { readEnvFile } from './env.js';
import { classifyError, AgentError, type RetryStrategy } from './errors.js';
import { logger } from './logger.js';

// ── MCP server loading ──────────────────────────────────────────────
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/**
 * Merge MCP server configs from multiple sources, optionally filtered by
 * an allowlist (e.g. from an agent's agent.yaml `mcp_servers` field).
 *
 * Sources checked (later entries override earlier ones):
 *   1. User settings:    ~/.claude/settings.json  (mcpServers key)
 *   2. Project settings: <cwd>/.claude/settings.json (mcpServers key)
 *   3. Project .mcp.json: <cwd>/.mcp.json (mcpServers key)
 *   4. Root .mcp.json:   PROJECT_ROOT/.mcp.json (mcpServers key)
 *
 * Supports both stdio servers (command field) and HTTP servers (url field).
 *
 * Exported so the voice bridge can reuse the exact same loader the text
 * bot uses, keeping behavior consistent across channels.
 */
export function loadMcpServers(allowlist?: string[], projectCwd?: string): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};

  const effectiveCwd = projectCwd ?? agentCwd ?? PROJECT_ROOT;

  // Load from settings.json files (mcpServers key inside JSON)
  const projectSettings = path.join(effectiveCwd, '.claude', 'settings.json');
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  // Load from .mcp.json files (mcpServers key at top level)
  const projectMcpJson = path.join(effectiveCwd, '.mcp.json');
  const rootMcpJson = effectiveCwd !== PROJECT_ROOT
    ? path.join(PROJECT_ROOT, '.mcp.json')
    : null;

  const sources = [userSettings, projectSettings, projectMcpJson];
  if (rootMcpJson) sources.push(rootMcpJson);

  for (const file of sources) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;

          // HTTP/Streamable MCP server (url-based)
          if (cfg.url && typeof cfg.url === 'string') {
            merged[name] = {
              type: 'http' as const,
              url: cfg.url,
              ...(cfg.headers ? { headers: cfg.headers as Record<string, string> } : {}),
            };
          }
          // Stdio MCP server (command-based)
          else if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid, skip
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active';
  description: string;
}

/** Map SDK tool names to human-readable labels. */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  // MCP tools: mcp__server__tool → "server: tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
  }
  return toolName;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
  /** True when the SDK stopped because maxTurns was exhausted. */
  hitTurnLimit?: boolean;
  /** Number of agentic turns the SDK executed. */
  numTurns?: number;
  /** Set when the agent was halted by the interrupt flag file. */
  interruptReason?: string;
  /** The tool that was about to execute when the interrupt fired. */
  interruptedTool?: string;
}

// ── Interrupt flag check ─────────────────────────────────────────────
// Constitutional safety hook: checks for a flag file before every tool
// call. If the flag exists, the agent halts immediately.

const INTERRUPT_FLAG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  'hive', 'control', 'interrupt.flag',
);

/**
 * Check if the interrupt flag file exists and return the reason if so.
 * Returns null if no interrupt is requested.
 * Fails safe: any error reading the file returns null (no interrupt).
 */
function checkInterruptFlag(): string | null {
  try {
    if (!fs.existsSync(INTERRUPT_FLAG_PATH)) return null;
    const content = fs.readFileSync(INTERRUPT_FLAG_PATH, 'utf-8').trim();
    return content || 'user_requested';
  } catch {
    // Fail safe: broken flag file or missing directory = no interrupt
    return null;
  }
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
): Promise<AgentResult> {
  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (secrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;
  let streamedText = '';
  let hitTurnLimit = false;
  let numTurns: number | undefined;
  let interruptReason: string | undefined;
  let interruptedTool: string | undefined;

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  try {
    // Load MCP servers from project + user settings files, filtered by agent allowlist
    const mcpServers = loadMcpServers(mcpAllowlist);
    const mcpServerNames = Object.keys(mcpServers);
    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length, mcpServers: mcpServerNames },
      'Starting agent query',
    );

    // SDK Options.mcpServers expects Record<string, McpServerConfig>
    const mcpServerSpecs = mcpServerNames.length > 0 ? mcpServers : undefined;

    for await (const event of query({
      prompt: singleTurn(message),
      options: {
        // cwd = agent directory (if running as agent) or project root.
        // Claude Code loads CLAUDE.md from cwd via settingSources: ['project'].
        cwd: agentCwd ?? PROJECT_ROOT,

        // Resume the previous session for this chat (persistent context)
        resume: sessionId,

        // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills/ and user settings
        settingSources: ['project', 'user'],

        // Skip all permission prompts — this is a trusted personal bot on your own machine
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // Cap agentic turns to prevent runaway tool-use loops (e.g. retrying
        // stale cookies 40+ times). Configurable via AGENT_MAX_TURNS in .env.
        ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),

        // Pass secrets to the subprocess without polluting our own process.env
        env: sdkEnv,

        // MCP servers loaded from .claude/settings.json and ~/.claude/settings.json
        ...(mcpServerSpecs ? { mcpServers: mcpServerSpecs } : {}),

        // Stream partial text so Telegram can show progressive updates
        includePartialMessages: !!onStreamText,

        // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5')
        ...(model ? { model } : {}),

        // Abort support — signals the SDK to kill the subprocess
        ...(abortController ? { abortController } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        logger.info({ newSessionId }, 'Session initialized');
      }

      // Detect auto-compaction (context window was getting full)
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens },
          'Context window compacted',
        );
      }

      // Track per-call token usage and detect tool use from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          lastCallCacheRead = callCacheRead;
        }
        if (callInputTokens > 0) {
          lastCallInputTokens = callInputTokens;
        }

        // Extract tool_use blocks from assistant content for progress reporting
        // and check interrupt flag before tool dispatch.
        const content = msg?.['content'] as Array<{ type: string; name?: string }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) {
              if (onProgress) {
                onProgress({ type: 'tool_active', description: toolLabel(block.name) });
              }

              // ── Interrupt flag check (Layer 2 constitutional safety) ──
              // Check BEFORE the SDK dispatches this tool. If the flag
              // exists, abort immediately so the tool never executes.
              const flagReason = checkInterruptFlag();
              if (flagReason) {
                interruptReason = flagReason;
                interruptedTool = block.name;
                logger.warn(
                  { reason: flagReason, tool: block.name },
                  'Interrupt flag detected — halting agent before tool dispatch',
                );
                if (abortController) {
                  abortController.abort();
                }
                break;
              }
            }
          }
        }
      }

      // Sub-agent lifecycle events — surface to Telegram for user feedback
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
        const desc = (ev['description'] as string) ?? 'Sub-agent started';
        onProgress({ type: 'task_started', description: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
        const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
        const status = (ev['status'] as string) ?? 'completed';
        onProgress({
          type: 'task_completed',
          description: status === 'failed' ? `Failed: ${summary}` : summary,
        });
      }

      // Stream text deltas for progressive Telegram updates.
      // Only stream the outermost assistant response (parent_tool_use_id === null)
      // to avoid showing internal tool-use reasoning.
      if (ev['type'] === 'stream_event' && onStreamText && ev['parent_tool_use_id'] === null) {
        const streamEvent = ev['event'] as Record<string, unknown> | undefined;
        if (streamEvent?.['type'] === 'content_block_delta') {
          const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            streamedText += delta['text'];
            onStreamText(streamedText);
          }
        }
        if (streamEvent?.['type'] === 'message_start') {
          streamedText = '';
        }
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Detect turn-limit exhaustion (B.2 Fix 1)
        const resultSubtype = ev['subtype'] as string | undefined;
        if (resultSubtype === 'error_max_turns') {
          hitTurnLimit = true;
          logger.warn('Agent hit maxTurns limit');
        }
        numTurns = (ev['num_turns'] as number | undefined) ?? undefined;

        // Extract usage info from result event
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
            didCompact,
            preCompactTokens,
            lastCallCacheRead,
            lastCallInputTokens,
          };
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: resultSubtype, numTurns, hitTurnLimit },
          'Agent result received',
        );
      }
    }
  } catch (err) {
    if (abortController?.signal.aborted) {
      if (interruptReason) {
        logger.info({ reason: interruptReason, tool: interruptedTool }, 'Agent halted by interrupt flag');
        return { text: null, newSessionId, usage, aborted: true, interruptReason, interruptedTool };
      }
      logger.info('Agent query aborted by user');
      return { text: null, newSessionId, usage, aborted: true };
    }

    // Classify the error and attach context-aware metadata
    const contextTokens = lastCallInputTokens || lastCallCacheRead || 0;
    const classified = classifyError(err, contextTokens || undefined);
    logger.error(
      { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
      'Agent query failed (classified)',
    );
    throw classified;
  } finally {
    clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId, usage, hitTurnLimit, numTurns };
}

// ── Retry wrapper ─────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 4; // 2s, 8s

/** Track repeated identical errors for self-heal (Fix 3). */
const recentErrors: { msg: string; ts: number }[] = [];
const SELF_HEAL_THRESHOLD = 3;
const SELF_HEAL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function recordErrorForSelfHeal(errMsg: string): boolean {
  const now = Date.now();
  // Prune old entries
  while (recentErrors.length > 0 && now - recentErrors[0].ts > SELF_HEAL_WINDOW_MS) {
    recentErrors.shift();
  }
  recentErrors.push({ msg: errMsg, ts: now });
  // Check if the same error hit threshold
  const count = recentErrors.filter((e) => e.msg === errMsg).length;
  if (count >= SELF_HEAL_THRESHOLD) {
    // Clear the tracker after triggering
    recentErrors.length = 0;
    return true; // signal: force session reset
  }
  return false;
}

/**
 * Strip image-related content from a message for retry.
 * Removes base64 data URIs, image file references, and [Image: ...] blocks.
 */
function stripImagesFromMessage(message: string): string {
  return message
    // Remove base64 image data URIs
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image removed]')
    // Remove [Image: ...] markers that the bot may inject
    .replace(/\[Image:[^\]]*\]/gi, '[image removed]')
    // Remove [Photo] or [Photo: ...] markers
    .replace(/\[Photo(?::[^\]]*)?\]/gi, '[image removed]')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the agent with automatic retry for transient errors.
 * Only retries errors where recovery.shouldRetry is true.
 * Supports retry strategies:
 *   - 'normal': standard retry with same message and session
 *   - 'strip_images_and_retry': remove image content from message
 *   - 'new_session': retry without a session ID (fresh context)
 * Calls onRetry before each retry so the caller can notify the user.
 *
 * Self-heal: if the same error occurs SELF_HEAL_THRESHOLD times within
 * SELF_HEAL_WINDOW_MS, forces a session reset automatically (Fix 3).
 */
export async function runAgentWithRetry(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  onRetry?: (attempt: number, error: AgentError) => void,
  fallbackModels?: string[],
  mcpAllowlist?: string[],
): Promise<AgentResult> {
  let lastError: AgentError | undefined;
  let currentMessage = message;
  let currentSessionId = sessionId;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const currentModel =
        attempt === 0 ? model
        : lastError?.recovery.shouldSwitchModel && fallbackModels?.length
          ? fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
          : model;

      return await runAgent(
        currentMessage, currentSessionId, onTyping, onProgress,
        currentModel, abortController, onStreamText,
        mcpAllowlist,
      );
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      lastError = err;

      // Don't retry non-retryable errors or if aborted
      if (!err.recovery.shouldRetry || abortController?.signal.aborted) {
        throw err;
      }

      // Don't retry past the limit
      if (attempt >= MAX_RETRIES) {
        throw err;
      }

      // Self-heal check (Fix 3): if same error repeats too many times, force new session
      const forceReset = recordErrorForSelfHeal(err.message);
      if (forceReset) {
        logger.warn('Self-heal triggered: same error repeated %d times, forcing session reset', SELF_HEAL_THRESHOLD);
        currentSessionId = undefined;
        // Continue to the retry below with cleared session
      }

      // Apply retry strategy (Fix 1 & 2)
      const strategy: RetryStrategy = err.recovery.retryStrategy ?? 'normal';
      if (strategy === 'strip_images_and_retry') {
        const stripped = stripImagesFromMessage(currentMessage);
        if (stripped !== currentMessage) {
          logger.info('Retry strategy: stripped image content from message');
          currentMessage = stripped;
        }
        // Also clear session to avoid poisoned session state
        currentSessionId = undefined;
        logger.info('Retry strategy: cleared session to avoid poisoned state');
      } else if (strategy === 'new_session') {
        currentSessionId = undefined;
        logger.info('Retry strategy: starting fresh session');
      }

      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
        60000,
      );
      // Add jitter (0-25% of delay)
      const jitter = Math.random() * delayMs * 0.25;

      logger.warn(
        { attempt: attempt + 1, category: err.category, strategy, delayMs: Math.round(delayMs + jitter) },
        'Retrying agent query',
      );

      onRetry?.(attempt + 1, err);
      await sleep(delayMs + jitter);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error('Retry loop exhausted');
}
