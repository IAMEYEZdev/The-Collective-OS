/**
 * Structured error taxonomy for ClaudeClaw agent failures.
 *
 * Classifies errors from the Claude Code SDK into actionable categories
 * with recovery hints, so the user gets helpful messages instead of
 * "Something went wrong."
 */

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'context_exhausted'
  | 'timeout'
  | 'subprocess_crash'
  | 'network'
  | 'billing'
  | 'overloaded'
  | 'bad_image'
  | 'bad_payload'
  | 'mcp_disconnect'
  | 'unknown';

export type RetryStrategy =
  | 'normal'
  | 'strip_images_and_retry'
  | 'new_session'
  | 'mcp_wakeup_and_retry';

export interface ErrorRecovery {
  shouldRetry: boolean;
  shouldNewChat: boolean;
  shouldSwitchModel: boolean;
  retryAfterMs: number;
  retryStrategy?: RetryStrategy;
  userMessage: string;
}

export class AgentError extends Error {
  category: ErrorCategory;
  recovery: ErrorRecovery;
  originalError: Error | undefined;
  /**
   * Name of the affected MCP server, parsed from the SDK error string.
   * Only set when category === 'mcp_disconnect' and extraction succeeded.
   * The watchdog uses this to look up a wake-up command in MCP_WAKEUP_REGISTRY.
   */
  mcpServerName: string | undefined;

  constructor(
    category: ErrorCategory,
    recovery: ErrorRecovery,
    originalError?: Error,
    mcpServerName?: string,
  ) {
    super(recovery.userMessage);
    this.name = 'AgentError';
    this.category = category;
    this.recovery = recovery;
    this.originalError = originalError;
    this.mcpServerName = mcpServerName;
  }
}

// ── Pattern matchers ────────────────────────────────────────────────

const AUTH_PATTERNS = [
  'authentication',
  'unauthorized',
  'invalid api key',
  'invalid x-api-key',
  'api key not found',
  'not authenticated',
  'permission denied',
  'oauth',
  'token expired',
  'invalid_grant',
  'login required',
];

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'throttled',
  'requests per minute',
  '429',
];

const BILLING_PATTERNS = [
  'insufficient credits',
  'credits exhausted',
  'payment required',
  'billing',
  'quota exceeded',
  'usage limit',
  '402',
];

const OVERLOADED_PATTERNS = [
  'overloaded',
  'service unavailable',
  'capacity',
  '529',
  '503',
];

const NETWORK_PATTERNS = [
  'enotfound',
  'econnrefused',
  'econnreset',
  'etimedout',
  'socket hang up',
  'network',
  'dns',
  'fetch failed',
  'certificate',
  'connectionrefused',
  'unable to connect',
];

const TIMEOUT_PATTERNS = [
  'timed out',
  'timeout',
  'deadline exceeded',
];

const CONTEXT_PATTERNS = [
  'context length',
  'context window',
  'max_tokens',
  'maximum tokens',
  'max input tokens',
  'too long',
  'token limit',
];

const BAD_IMAGE_PATTERNS = [
  'could not process image',
  'invalid image',
  'image too large',
  'unsupported image',
  'unable to process image',
  'image format not supported',
  'failed to decode image',
  'image processing error',
  'cannot decode image',
  'invalid base64',
  'invalid media type',
];

const BAD_PAYLOAD_PATTERNS = [
  'invalid content',
  'malformed request',
  'invalid message format',
  'could not parse',
  'invalid request body',
];

// MCP server disconnected mid-session. Claude Code's client does NOT auto-respawn,
// so the watchdog catches these errors, runs the server's wake-up command, and
// retries the turn once.
//
// Real SDK errors interleave the server name (e.g. `MCP server "basic-memory":
// connection closed`), so we detect with a two-stage match:
//   1. The text mentions "mcp server" or "mcp transport" (primary signal).
//   2. AND one of the disconnect-symptom hints below appears anywhere.
// Single-phrase fall-back patterns cover edge cases that don't include the
// server name (e.g. raw "MCP transport closed").
const MCP_PRIMARY_HINTS = ['mcp server', 'mcp transport', 'connection to mcp', 'mcp client'];
const MCP_DISCONNECT_HINTS = [
  'disconnect',
  'transport closed',
  'connection closed',
  'connection lost',
  'terminated',
  'timed out',
  'crashed',
  'exited',
  'not connected',
  'has gone away',
  'pipe closed',
];
const MCP_SOLO_PATTERNS = [
  'mcp transport closed',
  'lost connection to mcp',
  'not connected to mcp server',
];

function isMcpDisconnect(text: string): boolean {
  const lower = text.toLowerCase();
  if (MCP_SOLO_PATTERNS.some((p) => lower.includes(p))) return true;
  const primaryHit = MCP_PRIMARY_HINTS.some((p) => lower.includes(p));
  if (!primaryHit) return false;
  return MCP_DISCONNECT_HINTS.some((h) => lower.includes(h));
}

const MCP_SERVER_NAME_REGEX = /MCP server ["']([^"']+)["']/i;

/**
 * Parse the affected MCP server name out of an SDK error message.
 * The SDK emits errors of the form: `MCP server "basic-memory": <reason>`.
 * Returns undefined if the pattern doesn't match — callers must handle that.
 * Fail-safe: never throws; regex errors return undefined.
 */
export function extractMcpServerName(text: string): string | undefined {
  try {
    const m = text.match(MCP_SERVER_NAME_REGEX);
    return m && m[1] ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ── Classification ──────────────────────────────────────────────────

/**
 * Classify a raw error from the Claude Code SDK into a structured AgentError.
 * Parses the error message and any stderr output for known patterns.
 * If the error is already an AgentError, returns it unchanged.
 */
export function classifyError(err: unknown, contextTokens?: number): AgentError {
  // Pass through already-classified errors
  if (err instanceof AgentError) return err;

  const raw = err instanceof Error ? err : new Error(String(err));
  const text = raw.message;

  // Context exhaustion: process exits with code 1 when context is full
  if (text.includes('exited with code 1') && contextTokens && contextTokens > 0) {
    return new AgentError('context_exhausted', {
      shouldRetry: false,
      shouldNewChat: true,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: `Context window likely exhausted (~${Math.round(contextTokens / 1000)}k tokens). Use /newchat to start fresh, then /respin to pull recent conversation back in.`,
    }, raw);
  }

  // Subprocess crash without context data
  if (text.includes('exited with code 1')) {
    return new AgentError('subprocess_crash', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 2000,
      userMessage: 'Claude Code subprocess crashed. Retrying...',
    }, raw);
  }

  if (text.includes('exited with code')) {
    return new AgentError('subprocess_crash', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 2000,
      userMessage: 'Claude Code subprocess exited unexpectedly. Retrying...',
    }, raw);
  }

  // MCP disconnect must be classified before NETWORK / TIMEOUT / OVERLOADED so
  // that the underlying reason in an MCP error message (e.g. "MCP server x timed
  // out") doesn't get mis-classified as a generic timeout.
  if (isMcpDisconnect(text)) {
    const serverName = extractMcpServerName(text);
    return new AgentError(
      'mcp_disconnect',
      {
        shouldRetry: true,
        shouldNewChat: false,
        shouldSwitchModel: false,
        // The wakeup-and-retry strategy manages its own timing (handshake wait).
        retryAfterMs: 0,
        retryStrategy: 'mcp_wakeup_and_retry',
        userMessage: serverName
          ? `MCP server "${serverName}" reconnected. Continuing your request...`
          : 'MCP server reconnected. Continuing your request...',
      },
      raw,
      serverName,
    );
  }

  if (matchesAny(text, AUTH_PATTERNS)) {
    return new AgentError('auth', {
      shouldRetry: false,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: 'Authentication failed. Run `claude login` in your terminal to re-authenticate.',
    }, raw);
  }

  if (matchesAny(text, BILLING_PATTERNS)) {
    return new AgentError('billing', {
      shouldRetry: false,
      shouldNewChat: false,
      shouldSwitchModel: true,
      retryAfterMs: 0,
      userMessage: 'API credits exhausted or billing issue. Check your Anthropic account, or try a different model.',
    }, raw);
  }

  if (matchesAny(text, RATE_LIMIT_PATTERNS)) {
    return new AgentError('rate_limit', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 30000,
      userMessage: 'Rate limited. Retrying in 30s...',
    }, raw);
  }

  if (matchesAny(text, OVERLOADED_PATTERNS)) {
    return new AgentError('overloaded', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: true,
      retryAfterMs: 5000,
      userMessage: 'Model is overloaded. Retrying...',
    }, raw);
  }

  if (matchesAny(text, NETWORK_PATTERNS)) {
    return new AgentError('network', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 3000,
      userMessage: 'Network error. Check your connection. Retrying...',
    }, raw);
  }

  if (matchesAny(text, TIMEOUT_PATTERNS)) {
    return new AgentError('timeout', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 2000,
      userMessage: 'Request timed out. Retrying...',
    }, raw);
  }

  if (matchesAny(text, CONTEXT_PATTERNS)) {
    return new AgentError('context_exhausted', {
      shouldRetry: false,
      shouldNewChat: true,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: 'Context window limit reached. Use /newchat to start fresh.',
    }, raw);
  }

  // Bad image: poison payload that will persist in session state
  if (matchesAny(text, BAD_IMAGE_PATTERNS)) {
    return new AgentError('bad_image', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 1000,
      retryStrategy: 'strip_images_and_retry',
      userMessage: "I couldn't read an image in your last message. Retrying without it. If this keeps happening, use /newchat.",
    }, raw);
  }

  // Bad payload: request structure that the API can't parse
  if (matchesAny(text, BAD_PAYLOAD_PATTERNS)) {
    return new AgentError('bad_payload', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 1000,
      retryStrategy: 'new_session',
      userMessage: "A message in the session caused an API error. Retrying with a fresh session.",
    }, raw);
  }

  // Unknown: provide actionable info instead of a dead end
  return new AgentError('unknown', {
    shouldRetry: false,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: `An unexpected error occurred: "${text.slice(0, 100)}". Try /newchat if this persists.`,
  }, raw);
}
