import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { runAcpAgent } from './acp-runner.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFakeAcpAgent(mode: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-acp-test-'));
  tmpDirs.push(dir);
  const acpUrl = pathToFileURL(path.join(process.cwd(), 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')).href;
  const script = path.join(dir, 'fake-acp-agent.mjs');
  fs.writeFileSync(script, `
import { Readable, Writable } from 'node:stream';
import * as acp from ${JSON.stringify(acpUrl)};

class FakeAgent {
  constructor(conn) { this.conn = conn; this.sessions = new Set(); this.pending = new Map(); }
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: ${mode === 'noresume' ? '{ loadSession: false }' : '{ loadSession: false, session: { resume: true } }'},
    };
  }
  async newSession() { const id = 'sess-' + ${JSON.stringify(mode)}; this.sessions.add(id); return { sessionId: id }; }
  async resumeSession(params) { this.sessions.add(params.sessionId); return {}; }
  async authenticate() { return {}; }
  async setSessionMode() { return {}; }
  async prompt(params) {
    if (${JSON.stringify(mode)} === 'error') throw new Error('fake acp failure');
    if (${JSON.stringify(mode)} === 'abort') {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1000);
        this.pending.set(params.sessionId, () => { clearTimeout(t); resolve(); });
      });
      return { stopReason: 'cancelled' };
    }
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'Inspect project', priority: 'high', status: 'in_progress' }] } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Reading files', kind: 'read', status: 'pending', locations: [{ path: 'README.md', line: 12 }] } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Reading files', status: 'completed' } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } });
    return { stopReason: 'end_turn' };
  }
  async cancel(params) { const done = this.pending.get(params.sessionId); if (done) done(); }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`, 'utf-8');
  return script;
}

function writeFakeOpenCode(mode: string): { oldPath: string } {
  return writeFakePresetCommand('opencode', ['acp'], mode);
}

function writeFakePresetCommand(command: string, expectedArgs: string[], mode: string): { oldPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-opencode-test-'));
  tmpDirs.push(dir);
  const agentScript = writeFakeAcpAgent(mode);
  const bin = path.join(dir, command);
  const argAssertions = expectedArgs
    .map((arg, idx) => `test "$${idx + 1}" = ${JSON.stringify(arg)} || exit 42`)
    .join('\n');
  const arityAssertion = `test "$#" = "${expectedArgs.length}" || exit 42`;
  fs.writeFileSync(bin, [
    '#!/usr/bin/env sh',
    arityAssertion,
    argAssertions,
    `exec "${process.execPath}" "${agentScript}"`,
    '',
  ].join('\n'), 'utf-8');
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  return { oldPath };
}

describe('runAcpAgent', () => {
  it('initializes, streams text, reports progress, and returns result', async () => {
    const script = writeFakeAcpAgent('ok');
    const streamed: string[] = [];
    const progress: Array<{ description: string; type: string; status?: string; path?: string }> = [];

    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
      (event) => progress.push({
        description: event.description,
        type: event.type,
        status: event.status,
        path: event.locations?.[0]?.path,
      }),
      undefined,
      (text) => streamed.push(text),
    );

    expect(result.text).toBe('hello world');
    expect(result.newSessionId).toBe('sess-ok');
    expect(result.usage?.inputTokens).toBe(0);
    expect(streamed).toEqual(['hello ', 'hello world']);
    expect(progress).toContainEqual(expect.objectContaining({
      description: 'Inspect project',
      type: 'plan',
      status: 'in_progress',
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      description: 'Reading files',
      type: 'tool_active',
      status: 'pending',
      path: 'README.md',
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      description: 'Reading files',
      type: 'tool_active',
      status: 'completed',
    }));
  });

  it('resumes an existing ACP session id', async () => {
    const script = writeFakeAcpAgent('ok');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      'existing-session',
    );

    expect(result.newSessionId).toBe('existing-session');
    expect(result.text).toBe('hello world');
  });

  it('starts a new session when the provider does not support resume', async () => {
    const script = writeFakeAcpAgent('noresume');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      'existing-session',
    );

    expect(result.newSessionId).toBe('sess-noresume');
    expect(result.text).toBe('hello world');
  });

  it('launches OpenCode through the opencode acp preset', async () => {
    const { oldPath } = writeFakeOpenCode('ok');
    try {
      const result = await runAcpAgent({ type: 'opencode' }, 'hi', undefined);
      expect(result.newSessionId).toBe('sess-ok');
      expect(result.text).toBe('hello world');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('launches Gemini through the gemini --acp preset', async () => {
    const { oldPath } = writeFakePresetCommand('gemini', ['--acp'], 'ok');
    try {
      const result = await runAcpAgent({ type: 'gemini' }, 'hi', undefined);
      expect(result.newSessionId).toBe('sess-ok');
      expect(result.text).toBe('hello world');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('launches Codex through the codex-acp adapter preset', async () => {
    const { oldPath } = writeFakePresetCommand('codex-acp', [], 'ok');
    try {
      const result = await runAcpAgent({ type: 'codex' }, 'hi', undefined);
      expect(result.newSessionId).toBe('sess-ok');
      expect(result.text).toBe('hello world');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('surfaces ACP errors', async () => {
    const script = writeFakeAcpAgent('error');
    await expect(runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
    )).rejects.toThrow(/fake acp failure/);
  });

  it('rejects cleanly when the ACP command is missing', async () => {
    await expect(runAcpAgent(
      { type: 'acp', command: 'claudeclaw-missing-acp-command' },
      'hi',
      undefined,
    )).rejects.toThrow(/Failed to start ACP provider command/);
  });

  it('returns aborted when cancelled', async () => {
    const script = writeFakeAcpAgent('abort');
    const ctrl = new AbortController();
    const promise = runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      'abort-session',
      undefined,
      ctrl,
    );
    setTimeout(() => ctrl.abort(), 50);
    const result = await promise;
    expect(result.aborted).toBe(true);
  });
});
