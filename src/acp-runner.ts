import { spawn } from 'child_process';
import path from 'path';
import { Readable, Writable } from 'stream';

import * as acp from '@agentclientprotocol/sdk';

import { PROJECT_ROOT, agentCwd } from './config.js';
import type { AgentProgressEvent, AgentResult, UsageInfo } from './agent.js';
import { logger } from './logger.js';
import { ProviderConfig } from './provider.js';

class ClaudeClawAcpClient {
  private accumulatedText = '';
  private toolTitles = new Map<string, string>();

  constructor(
    private readonly onProgress?: (event: AgentProgressEvent) => void,
    private readonly onStreamText?: (accumulatedText: string) => void,
  ) {}

  get text(): string {
    return this.accumulatedText;
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && content.text) {
          this.accumulatedText += content.text;
          this.onStreamText?.(this.accumulatedText);
        }
        break;
      }
      case 'tool_call': {
        const title = typeof update.title === 'string' ? update.title : 'Tool active';
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        if (toolCallId) this.toolTitles.set(toolCallId, title);
        this.onProgress?.({
          type: 'tool_active',
          description: title,
          status: typeof update.status === 'string' ? update.status : 'pending',
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          toolCallId,
          locations: parseLocations(update.locations),
        });
        break;
      }
      case 'tool_call_update': {
        const status = typeof update.status === 'string' ? update.status : undefined;
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        const title = typeof update.title === 'string'
          ? update.title
          : toolCallId ? this.toolTitles.get(toolCallId) : undefined;
        if (toolCallId && title) this.toolTitles.set(toolCallId, title);
        this.onProgress?.({
          type: status === 'failed' ? 'task_completed' : 'tool_active',
          description: title ?? (status ? `Tool ${status}` : 'Tool update'),
          status,
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          toolCallId,
          locations: parseLocations(update.locations),
        });
        break;
      }
      case 'plan': {
        const planEntries = parsePlanEntries(update.entries);
        const active = planEntries.find((entry) => entry.status === 'in_progress')
          ?? planEntries.find((entry) => entry.status === 'pending')
          ?? planEntries[0];
        if (active) {
          this.onProgress?.({
            type: 'plan',
            description: active.content,
            status: active.status,
            planEntries,
          });
        }
        break;
      }
    }
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const allow = params.options.find((o) => o.kind === 'allow_always')
      ?? params.options.find((o) => o.kind === 'allow_once')
      ?? params.options[0];
    if (!allow) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const fs = await import('fs');
    return { content: fs.readFileSync(params.path, 'utf-8') };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const fs = await import('fs');
    fs.writeFileSync(params.path, params.content, 'utf-8');
    return {};
  }
}

function parseLocations(value: unknown): Array<{ path: string; line?: number | null }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: Array<{ path: string; line?: number | null }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== 'string') continue;
    const location: { path: string; line?: number | null } = { path: raw.path };
    if (typeof raw.line === 'number') location.line = raw.line;
    locations.push(location);
  }
  return locations.length ? locations : undefined;
}

function parsePlanEntries(value: unknown): Array<{ content: string; status: string; priority?: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ content: string; status: string; priority?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.content !== 'string' || typeof raw.status !== 'string') continue;
    const entry: { content: string; status: string; priority?: string } = {
      content: raw.content,
      status: raw.status,
    };
    if (typeof raw.priority === 'string') entry.priority = raw.priority;
    entries.push(entry);
  }
  return entries;
}

function getAcpCommand(provider: ProviderConfig): { command: string; args: string[] } {
  if (provider.type === 'opencode') return { command: 'opencode', args: ['acp'] };
  if (provider.type === 'gemini') return { command: 'gemini', args: ['--acp'] };
  if (provider.type === 'codex') return { command: 'codex-acp', args: [] };
  if (!provider.command) throw new Error('ACP provider requires a command');
  return { command: provider.command, args: provider.args ?? [] };
}

function getAcpEnv(): NodeJS.ProcessEnv {
  const localBin = path.join(PROJECT_ROOT, 'node_modules', '.bin');
  return {
    ...process.env,
    PATH: process.env.PATH
      ? `${process.env.PATH}${path.delimiter}${localBin}`
      : localBin,
  };
}

function emptyUsage(): UsageInfo {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    didCompact: false,
    preCompactTokens: null,
    lastCallCacheRead: 0,
    lastCallInputTokens: 0,
  };
}

function isSessionNotFoundError(err: unknown): boolean {
  const data = (err as { data?: unknown })?.data;
  const message = err instanceof Error ? err.message : String(err);
  const dataText = typeof data === 'string'
    ? data
    : data ? JSON.stringify(data) : '';
  return /session not found/i.test(`${message}\n${dataText}`);
}

export async function runAcpAgent(
  provider: ProviderConfig,
  message: string,
  sessionId: string | undefined,
  onProgress?: (event: AgentProgressEvent) => void,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
): Promise<AgentResult> {
  const { command, args } = getAcpCommand(provider);
  const child = spawn(command, args, {
    cwd: agentCwd ?? PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: getAcpEnv(),
  });
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      const hint = err.code === 'ENOENT'
        ? ` Make sure "${command}" is installed and available on PATH for the ClaudeClaw service.`
        : '';
      reject(new Error(`Failed to start ACP provider command "${command}": ${err.message}.${hint}`));
    });
  });

  const withSpawnError = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, spawnErrorPromise]);

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const client = new ClaudeClawAcpClient(onProgress, onStreamText);
  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!);
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => client, stream);

  const abortHandler = () => {
    if (sessionId) void connection.cancel({ sessionId }).catch(() => {});
    child.kill('SIGTERM');
  };
  abortController?.signal.addEventListener('abort', abortHandler, { once: true });

  try {
    const init = await withSpawnError(connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: 'ClaudeClaw', version: '1.1.0' },
    }));

    logger.info(
      { provider: provider.type, protocolVersion: init.protocolVersion, agent: init.agentInfo?.name },
      'ACP provider initialized',
    );

    let activeSessionId = sessionId;
    const capabilities = init.agentCapabilities as Record<string, unknown>;
    const sessionCaps = capabilities.session && typeof capabilities.session === 'object'
      ? capabilities.session as Record<string, unknown>
      : undefined;
    const canResumeSession = sessionCaps?.resume === true;

    if (activeSessionId) {
      if (canResumeSession) {
        try {
          await withSpawnError(connection.resumeSession({ sessionId: activeSessionId, cwd: agentCwd ?? PROJECT_ROOT }));
        } catch (err) {
          if (!isSessionNotFoundError(err)) throw err;
          logger.warn({ provider: provider.type, sessionId: activeSessionId }, 'ACP provider could not resume session; starting a new session');
          activeSessionId = undefined;
        }
      } else {
        logger.info({ provider: provider.type }, 'ACP provider does not advertise session resume; starting a new session');
        activeSessionId = undefined;
      }
    }

    const createSession = async (): Promise<string> => {
      const created = await withSpawnError(connection.newSession({
        cwd: agentCwd ?? PROJECT_ROOT,
        mcpServers: [],
      }));
      return created.sessionId;
    };

    if (!activeSessionId) {
      activeSessionId = await createSession();
    }

    onProgress?.({ type: 'task_started', description: `${provider.type} session started` });
    let promptResult: acp.PromptResponse;
    try {
      promptResult = await withSpawnError(connection.prompt({
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: message }],
      }));
    } catch (err) {
      if (!isSessionNotFoundError(err)) throw err;
      logger.warn({ provider: provider.type, sessionId: activeSessionId }, 'ACP provider rejected stale session; starting a new session');
      activeSessionId = await createSession();
      promptResult = await withSpawnError(connection.prompt({
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: message }],
      }));
    }

    if (promptResult.stopReason === 'cancelled' || abortController?.signal.aborted) {
      return { text: client.text || null, newSessionId: activeSessionId, usage: emptyUsage(), aborted: true };
    }

    return {
      text: client.text || null,
      newSessionId: activeSessionId,
      usage: emptyUsage(),
    };
  } catch (err) {
    if (abortController?.signal.aborted) {
      return { text: client.text || null, newSessionId: sessionId, usage: emptyUsage(), aborted: true };
    }
    logger.error({ err, stderr }, 'ACP provider query failed');
    const data = (err as { data?: { details?: unknown } })?.data;
    if (typeof data?.details === 'string') {
      throw new Error(data.details);
    }
    throw err;
  } finally {
    abortController?.signal.removeEventListener('abort', abortHandler);
    child.kill();
  }
}
