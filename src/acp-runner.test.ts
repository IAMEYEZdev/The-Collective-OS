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
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false, session: { resume: true } } }; }
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
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Reading files', kind: 'read', status: 'pending' } });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-opencode-test-'));
  tmpDirs.push(dir);
  const agentScript = writeFakeAcpAgent(mode);
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env sh',
    'test "$1" = "acp" || exit 42',
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
    const progress: string[] = [];

    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
      (event) => progress.push(event.description),
      undefined,
      (text) => streamed.push(text),
    );

    expect(result.text).toBe('hello world');
    expect(result.newSessionId).toBe('sess-ok');
    expect(result.usage?.inputTokens).toBe(0);
    expect(streamed).toEqual(['hello ', 'hello world']);
    expect(progress).toContain('Reading files');
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

  it('surfaces ACP errors', async () => {
    const script = writeFakeAcpAgent('error');
    await expect(runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
    )).rejects.toThrow(/fake acp failure/);
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
