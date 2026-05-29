# Claw-Code Integration Plan -- Collective OS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire claw-code (Rust agent harness, 9 crates, 48K LOC) into ClaudeClaw Collective OS so all 6 agents gain RAG-powered context, permission enforcement, event-driven coordination, and Rust-speed tool execution.

**Architecture:** Claw-code integrates as a Borg Arc adapter via subprocess IPC (JSON over stdin/stdout). Three layers: (1) Adapter bridges TypeScript orchestrator to Rust binary, (2) RAG service runs as Docker sidecar for shared knowledge, (3) Event bridge maps claw-code telemetry to hive-cli events. Each layer is independently useful and testable.

**Tech Stack:** TypeScript (ClaudeClaw OS), Rust (claw-code), Docker Compose (RAG + Qdrant), JSON IPC (subprocess), HTTP (RAG API)

**Absorption Doctrine Status:** Scout DONE, Evaluate DONE, Fork DONE (both claw-code + claw-code-parity). This plan covers Operationalize + Compound.

---

## File Structure

### New Files
| Path | Responsibility |
|------|---------------|
| `src/borg-arc/adapters/claw-code-adapter.ts` | Borg Arc adapter -- subprocess lifecycle, JSON IPC, health checks |
| `src/borg-arc/adapters/claw-code-types.ts` | TypeScript types for claw-code JSON protocol |
| `src/borg-arc/adapters/claw-code-rag.ts` | HTTP client for claw-rag-service (query, ingest, stats) |
| `src/borg-arc/adapters/claw-code-events.ts` | Telemetry bridge -- maps claw-code JSONL events to hive-cli format |
| `scripts/claw-code-build.sh` | Build script for Rust binary from forks/claw-code-collective |
| `scripts/claw-code-docker.sh` | Start/stop RAG service + Qdrant via docker compose |
| `docker/claw-code-compose.yml` | Docker compose overlay for RAG sidecar in Collective OS |
| `tests/borg-arc/claw-code-adapter.test.ts` | Adapter unit tests |
| `tests/borg-arc/claw-code-rag.test.ts` | RAG client tests |
| `tests/borg-arc/claw-code-events.test.ts` | Event bridge tests |

### Modified Files
| Path | Change |
|------|--------|
| `src/borg-arc/adapters/adapter.ts` | Register claw-code adapter in AdapterFactory |
| `src/orchestrator.ts` | Wire claw-code adapter into agent dispatch path |
| `src/scheduler.ts` | Add RAG context enrichment option for scheduled tasks |
| `src/types.ts` | Add ClawCodeConfig to system config types |
| `.env.example` | Add CLAW_CODE_BIN, CLAW_RAG_URL env vars |
| `agents/*/agent.yaml` | Add claw_code capability flag per agent |

---

## Phase 1: Operationalize -- Adapter Foundation (Tasks 1-5)

### Task 1: Claw-Code Type Definitions

**Files:**
- Create: `src/borg-arc/adapters/claw-code-types.ts`
- Test: `tests/borg-arc/claw-code-adapter.test.ts`

- [ ] **Step 1: Write failing test for type exports**

```typescript
// tests/borg-arc/claw-code-adapter.test.ts
import { describe, it, expect } from 'vitest';
import {
  ClawCodeRequest,
  ClawCodeResponse,
  ClawCodeHealthStatus,
  ClawCodeConfig,
} from '../../src/borg-arc/adapters/claw-code-types';

describe('claw-code types', () => {
  it('ClawCodeRequest has required fields', () => {
    const req: ClawCodeRequest = {
      prompt: 'test prompt',
      model: 'claude-sonnet-4-20250514',
      outputFormat: 'json',
      tools: [],
      permissionMode: 'sandboxed',
    };
    expect(req.prompt).toBe('test prompt');
    expect(req.permissionMode).toBe('sandboxed');
  });

  it('ClawCodeResponse parses completion', () => {
    const res: ClawCodeResponse = {
      id: 'sess_123',
      status: 'completed',
      output: 'result text',
      toolsUsed: ['bash', 'read'],
      tokensIn: 500,
      tokensOut: 200,
      costUsd: 0.003,
      durationMs: 4500,
    };
    expect(res.status).toBe('completed');
    expect(res.costUsd).toBe(0.003);
  });

  it('ClawCodeConfig validates env requirements', () => {
    const cfg: ClawCodeConfig = {
      binPath: '/usr/local/bin/claw',
      ragUrl: 'http://localhost:8787',
      anthropicApiKey: 'sk-ant-xxx',
      defaultModel: 'claude-sonnet-4-20250514',
      defaultPermissionMode: 'sandboxed',
      timeoutMs: 300000,
    };
    expect(cfg.binPath).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/borg-arc/claw-code-adapter.test.ts`
Expected: FAIL -- cannot resolve module `claw-code-types`

- [ ] **Step 3: Write type definitions**

```typescript
// src/borg-arc/adapters/claw-code-types.ts

export type PermissionMode = 'unrestricted' | 'interactive' | 'sandboxed';

export interface ClawCodeRequest {
  prompt: string;
  model: string;
  outputFormat: 'json' | 'text' | 'stream';
  tools: string[];
  permissionMode: PermissionMode;
  workspaceRoot?: string;
  sessionId?: string;
  ragContext?: string;
}

export interface ClawCodeResponse {
  id: string;
  status: 'completed' | 'failed' | 'timeout' | 'permission_denied';
  output: string;
  toolsUsed: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface ClawCodeHealthStatus {
  binary: boolean;
  version: string;
  ragService: boolean;
  ragChunks: number;
  qdrant: boolean;
}

export interface ClawCodeConfig {
  binPath: string;
  ragUrl: string;
  anthropicApiKey: string;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  timeoutMs: number;
}

export interface ClawCodeTelemetryEvent {
  type: 'tool_use' | 'bash_exec' | 'file_op' | 'api_call' | 'session_end';
  timestamp: string;
  sessionId: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  toolName?: string;
  command?: string;
  filePath?: string;
  costUsd?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/borg-arc/claw-code-adapter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/borg-arc/adapters/claw-code-types.ts tests/borg-arc/claw-code-adapter.test.ts
git commit -m "feat(claw-code): add TypeScript type definitions for claw-code IPC protocol"
```

---

### Task 2: Claw-Code Borg Arc Adapter

**Files:**
- Create: `src/borg-arc/adapters/claw-code-adapter.ts`
- Modify: `src/borg-arc/adapters/adapter.ts`
- Test: `tests/borg-arc/claw-code-adapter.test.ts`

- [ ] **Step 1: Write failing tests for adapter lifecycle**

```typescript
// Append to tests/borg-arc/claw-code-adapter.test.ts
import { ClawCodeAdapter } from '../../src/borg-arc/adapters/claw-code-adapter';
import { execSync } from 'child_process';
import { vi } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

describe('ClawCodeAdapter', () => {
  const mockConfig: ClawCodeConfig = {
    binPath: '/usr/local/bin/claw',
    ragUrl: 'http://localhost:8787',
    anthropicApiKey: 'sk-ant-test',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultPermissionMode: 'sandboxed',
    timeoutMs: 300000,
  };

  it('validateConfig checks binary exists', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('claw 0.1.3'));
    const adapter = new ClawCodeAdapter(mockConfig);
    const result = await adapter.validateConfig();
    expect(result.valid).toBe(true);
  });

  it('validateConfig fails when binary missing', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    const adapter = new ClawCodeAdapter(mockConfig);
    const result = await adapter.validateConfig();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('binary');
  });

  it('healthCheck returns structured status', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(JSON.stringify({
      binary: true, version: '0.1.3', rag: true, qdrant: true,
    })));
    const adapter = new ClawCodeAdapter(mockConfig);
    const health = await adapter.healthCheck();
    expect(health.binary).toBe(true);
    expect(health.version).toBe('0.1.3');
  });

  it('execute sends prompt and parses JSON response', async () => {
    const mockResponse: ClawCodeResponse = {
      id: 'sess_test',
      status: 'completed',
      output: 'Hello world',
      toolsUsed: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      durationMs: 2000,
    };
    vi.mocked(execSync).mockReturnValue(Buffer.from(JSON.stringify(mockResponse)));

    const adapter = new ClawCodeAdapter(mockConfig);
    const result = await adapter.execute({ prompt: 'say hello', model: 'claude-sonnet-4-20250514', outputFormat: 'json', tools: [], permissionMode: 'sandboxed' });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('Hello world');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/borg-arc/claw-code-adapter.test.ts`
Expected: FAIL -- cannot resolve `claw-code-adapter`

- [ ] **Step 3: Write adapter implementation**

```typescript
// src/borg-arc/adapters/claw-code-adapter.ts
import { execSync } from 'child_process';
import {
  ClawCodeConfig,
  ClawCodeRequest,
  ClawCodeResponse,
  ClawCodeHealthStatus,
} from './claw-code-types';
import { BaseAdapter, NormalizedEvent, EventStatus, AdapterFactory } from './adapter';

interface ValidationResult {
  valid: boolean;
  error?: string;
}

export class ClawCodeAdapter extends BaseAdapter {
  static FINGERPRINT_FIELDS = ['id', 'status'];
  private config: ClawCodeConfig;

  constructor(config: ClawCodeConfig) {
    super();
    this.config = config;
  }

  async validateConfig(): Promise<ValidationResult> {
    try {
      const out = execSync(`"${this.config.binPath}" --version`, {
        timeout: 5000,
        encoding: 'utf-8',
      });
      if (!out.includes('claw')) {
        return { valid: false, error: 'binary exists but not claw-code' };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: `claw-code binary not found at ${this.config.binPath}` };
    }
  }

  async healthCheck(): Promise<ClawCodeHealthStatus> {
    try {
      const out = execSync(`"${this.config.binPath}" doctor --output-format json`, {
        timeout: 10000,
        encoding: 'utf-8',
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.anthropicApiKey,
        },
      });
      const parsed = JSON.parse(out);
      return {
        binary: true,
        version: parsed.version || 'unknown',
        ragService: parsed.rag ?? false,
        ragChunks: parsed.ragChunks ?? 0,
        qdrant: parsed.qdrant ?? false,
      };
    } catch (err) {
      return {
        binary: false,
        version: 'unreachable',
        ragService: false,
        ragChunks: 0,
        qdrant: false,
      };
    }
  }

  async execute(request: ClawCodeRequest): Promise<ClawCodeResponse> {
    try {
      const args = [
        'prompt',
        `"${request.prompt}"`,
        '--model', request.model,
        '--output-format', request.outputFormat,
      ];

      if (request.workspaceRoot) {
        args.push('--workspace', request.workspaceRoot);
      }

      const out = execSync(`"${this.config.binPath}" ${args.join(' ')}`, {
        timeout: this.config.timeoutMs,
        encoding: 'utf-8',
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.anthropicApiKey,
        },
      });

      return JSON.parse(out) as ClawCodeResponse;
    } catch (err: any) {
      return {
        id: 'error',
        status: 'failed',
        output: '',
        toolsUsed: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        durationMs: 0,
        error: err.message || 'unknown execution error',
      };
    }
  }

  formatEvent(response: ClawCodeResponse): NormalizedEvent {
    return {
      id: response.id,
      name: `claw-code:${response.status}`,
      status: response.status === 'completed' ? EventStatus.RESOLVED : EventStatus.FIRING,
      severity: response.status === 'failed' ? 'critical' : 'info',
      description: response.output.slice(0, 200),
      source: 'claw-code',
      lastReceived: new Date().toISOString(),
    };
  }

  async dispose(): Promise<void> {
    // No persistent process to kill in sync mode
  }
}

// Register with Borg Arc adapter factory
AdapterFactory.register({
  type: 'claw-code',
  displayName: 'Claw-Code (Rust Agent Harness)',
  categories: ['Developer Tools', 'Agent Infrastructure'],
  tags: ['agent', 'rust', 'rag', 'permissions'],
  scopes: [],
  ctor: ClawCodeAdapter,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/borg-arc/claw-code-adapter.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/borg-arc/adapters/claw-code-adapter.ts tests/borg-arc/claw-code-adapter.test.ts
git commit -m "feat(claw-code): implement Borg Arc adapter with subprocess IPC"
```

---

### Task 3: RAG Service Client

**Files:**
- Create: `src/borg-arc/adapters/claw-code-rag.ts`
- Test: `tests/borg-arc/claw-code-rag.test.ts`

- [ ] **Step 1: Write failing tests for RAG client**

```typescript
// tests/borg-arc/claw-code-rag.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClawCodeRAGClient } from '../../src/borg-arc/adapters/claw-code-rag';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ClawCodeRAGClient', () => {
  const client = new ClawCodeRAGClient('http://localhost:8787');

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('query returns ranked chunks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { text: 'relevant chunk', score: 0.92, source: 'file.ts' },
          { text: 'another chunk', score: 0.85, source: 'other.ts' },
        ],
      }),
    });

    const results = await client.query('how does scheduling work?');
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('stats returns chunk count and phase', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ chunks: 1500, phase: 'ready' }),
    });

    const stats = await client.stats();
    expect(stats.chunks).toBe(1500);
    expect(stats.phase).toBe('ready');
  });

  it('health returns false on connection error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const healthy = await client.health();
    expect(healthy).toBe(false);
  });

  it('query returns empty array on error', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const results = await client.query('test');
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/borg-arc/claw-code-rag.test.ts`
Expected: FAIL -- cannot resolve `claw-code-rag`

- [ ] **Step 3: Write RAG client**

```typescript
// src/borg-arc/adapters/claw-code-rag.ts

export interface RAGResult {
  text: string;
  score: number;
  source: string;
}

export interface RAGStats {
  chunks: number;
  phase: string;
}

export class ClawCodeRAGClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async query(question: string, topK: number = 5): Promise<RAGResult[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question, top_k: topK }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.results || []) as RAGResult[];
    } catch {
      return [];
    }
  }

  async stats(): Promise<RAGStats> {
    const res = await fetch(`${this.baseUrl}/v1/stats`);
    return (await res.json()) as RAGStats;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ingest(workspacePaths: string[]): Promise<void> {
    await fetch(`${this.baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaces: workspacePaths }),
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/borg-arc/claw-code-rag.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/borg-arc/adapters/claw-code-rag.ts tests/borg-arc/claw-code-rag.test.ts
git commit -m "feat(claw-code): add RAG service HTTP client"
```

---

### Task 4: Event Bridge (Telemetry to Hive)

**Files:**
- Create: `src/borg-arc/adapters/claw-code-events.ts`
- Test: `tests/borg-arc/claw-code-events.test.ts`

- [ ] **Step 1: Write failing tests for event bridge**

```typescript
// tests/borg-arc/claw-code-events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ClawCodeEventBridge } from '../../src/borg-arc/adapters/claw-code-events';
import type { ClawCodeTelemetryEvent } from '../../src/borg-arc/adapters/claw-code-types';

describe('ClawCodeEventBridge', () => {
  it('maps tool_use event to hive action', () => {
    const event: ClawCodeTelemetryEvent = {
      type: 'tool_use',
      timestamp: '2026-05-29T21:00:00Z',
      sessionId: 'sess_123',
      model: 'claude-sonnet-4-20250514',
      toolName: 'bash',
      command: 'npm run build',
    };

    const bridge = new ClawCodeEventBridge();
    const hiveEntry = bridge.toHiveEntry(event);
    expect(hiveEntry.action).toBe('claw-tool-use');
    expect(hiveEntry.summary).toContain('bash');
    expect(hiveEntry.summary).toContain('npm run build');
  });

  it('maps session_end to hive with cost', () => {
    const event: ClawCodeTelemetryEvent = {
      type: 'session_end',
      timestamp: '2026-05-29T21:05:00Z',
      sessionId: 'sess_123',
      model: 'claude-sonnet-4-20250514',
      tokensIn: 5000,
      tokensOut: 2000,
      costUsd: 0.025,
    };

    const bridge = new ClawCodeEventBridge();
    const hiveEntry = bridge.toHiveEntry(event);
    expect(hiveEntry.action).toBe('claw-session-end');
    expect(hiveEntry.summary).toContain('$0.025');
    expect(hiveEntry.summary).toContain('7000'); // total tokens
  });

  it('formats batch of events into hive-cli commands', () => {
    const events: ClawCodeTelemetryEvent[] = [
      { type: 'tool_use', timestamp: '2026-05-29T21:00:00Z', sessionId: 's1', model: 'sonnet', toolName: 'read' },
      { type: 'file_op', timestamp: '2026-05-29T21:00:01Z', sessionId: 's1', model: 'sonnet', filePath: 'src/bot.ts' },
    ];

    const bridge = new ClawCodeEventBridge();
    const commands = bridge.toHiveCommands(events);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('hive-cli.js');
    expect(commands[0]).toContain('log');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/borg-arc/claw-code-events.test.ts`
Expected: FAIL -- cannot resolve `claw-code-events`

- [ ] **Step 3: Write event bridge**

```typescript
// src/borg-arc/adapters/claw-code-events.ts
import type { ClawCodeTelemetryEvent } from './claw-code-types';

export interface HiveEntry {
  action: string;
  summary: string;
}

export class ClawCodeEventBridge {
  toHiveEntry(event: ClawCodeTelemetryEvent): HiveEntry {
    switch (event.type) {
      case 'tool_use':
        return {
          action: 'claw-tool-use',
          summary: `[${event.sessionId}] ${event.toolName || 'unknown'}${event.command ? ': ' + event.command.slice(0, 80) : ''}`,
        };

      case 'bash_exec':
        return {
          action: 'claw-bash',
          summary: `[${event.sessionId}] ${event.command?.slice(0, 100) || 'bash exec'}`,
        };

      case 'file_op':
        return {
          action: 'claw-file-op',
          summary: `[${event.sessionId}] ${event.filePath || 'unknown file'}`,
        };

      case 'api_call':
        return {
          action: 'claw-api-call',
          summary: `[${event.sessionId}] ${event.model} in:${event.tokensIn || 0} out:${event.tokensOut || 0}`,
        };

      case 'session_end': {
        const totalTokens = (event.tokensIn || 0) + (event.tokensOut || 0);
        return {
          action: 'claw-session-end',
          summary: `[${event.sessionId}] ${event.model} ${totalTokens} tokens $${event.costUsd?.toFixed(3) || '0.000'}`,
        };
      }

      default:
        return {
          action: 'claw-event',
          summary: `[${event.sessionId}] ${event.type}`,
        };
    }
  }

  toHiveCommands(events: ClawCodeTelemetryEvent[]): string[] {
    const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT || '.';
    return events.map(event => {
      const entry = this.toHiveEntry(event);
      const escapedSummary = entry.summary.replace(/"/g, '\\"');
      return `node "${PROJECT_ROOT}/dist/hive-cli.js" log "${entry.action}" "${escapedSummary}"`;
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/borg-arc/claw-code-events.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/borg-arc/adapters/claw-code-events.ts tests/borg-arc/claw-code-events.test.ts
git commit -m "feat(claw-code): add telemetry-to-hive event bridge"
```

---

### Task 5: Docker Compose Overlay for RAG Sidecar

**Files:**
- Create: `docker/claw-code-compose.yml`
- Create: `scripts/claw-code-docker.sh`

- [ ] **Step 1: Write docker compose overlay**

```yaml
# docker/claw-code-compose.yml
# RAG sidecar for Collective OS -- extends claw-code's own compose
version: "3.8"

services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant-data:/qdrant/storage
    restart: unless-stopped

  claw-rag:
    build:
      context: ../forks/claw-code-collective/rust
      dockerfile: crates/claw-rag-service/Dockerfile
    ports:
      - "8787:8787"
    environment:
      - CLAW_RAG_DB=/data/rag.db
      - CLAW_RAG_HOST=0.0.0.0
      - CLAW_RAG_PORT=8787
      - QDRANT_URL=http://qdrant:6333
    volumes:
      - rag-data:/data
      - ../:/workspaces/claudeclaw:ro
      - ../forks:/workspaces/forks:ro
    depends_on:
      - qdrant
    restart: unless-stopped

volumes:
  qdrant-data:
  rag-data:
```

- [ ] **Step 2: Write management script**

```bash
#!/usr/bin/env bash
# scripts/claw-code-docker.sh
# Start/stop/status for claw-code RAG sidecar
set -euo pipefail

COMPOSE_FILE="${CLAUDECLAW_PROJECT_ROOT:-$(dirname "$0")/..}/docker/claw-code-compose.yml"

case "${1:-help}" in
  start)
    docker compose -f "$COMPOSE_FILE" up -d
    echo "RAG sidecar started. Health: http://localhost:8787/health"
    ;;
  stop)
    docker compose -f "$COMPOSE_FILE" down
    echo "RAG sidecar stopped."
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    curl -sf http://localhost:8787/health && echo " -- RAG healthy" || echo " -- RAG unreachable"
    ;;
  ingest)
    curl -sf -X POST http://localhost:8787/v1/ingest \
      -H 'Content-Type: application/json' \
      -d '{"workspaces":["/workspaces/claudeclaw","/workspaces/forks"]}'
    echo "Ingest triggered."
    ;;
  *)
    echo "Usage: $0 {start|stop|status|ingest}"
    exit 1
    ;;
esac
```

- [ ] **Step 3: Commit**

```bash
git add docker/claw-code-compose.yml scripts/claw-code-docker.sh
chmod +x scripts/claw-code-docker.sh
git commit -m "feat(claw-code): add Docker Compose overlay for RAG sidecar"
```

---

## Phase 2: Operationalize -- Orchestrator Wiring (Tasks 6-8)

### Task 6: Wire Adapter into Orchestrator Dispatch

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add ClawCodeConfig to system types**

In `src/types.ts`, add to the existing config interface:

```typescript
// Add to existing SystemConfig or equivalent
export interface ClawCodeConfig {
  enabled: boolean;
  binPath: string;
  ragUrl: string;
  defaultModel: string;
  defaultPermissionMode: 'unrestricted' | 'interactive' | 'sandboxed';
  timeoutMs: number;
}
```

- [ ] **Step 2: Wire claw-code adapter into orchestrator**

In `src/orchestrator.ts`, add import and initialization:

```typescript
// Add imports at top
import { ClawCodeAdapter } from './borg-arc/adapters/claw-code-adapter';
import { ClawCodeRAGClient } from './borg-arc/adapters/claw-code-rag';
import { ClawCodeEventBridge } from './borg-arc/adapters/claw-code-events';

// Add to orchestrator initialization (inside init or constructor):
const clawCodeConfig = {
  enabled: !!process.env.CLAW_CODE_BIN,
  binPath: process.env.CLAW_CODE_BIN || 'claw',
  ragUrl: process.env.CLAW_RAG_URL || 'http://localhost:8787',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  defaultModel: process.env.CLAW_CODE_MODEL || 'claude-sonnet-4-20250514',
  defaultPermissionMode: 'sandboxed' as const,
  timeoutMs: 300000,
};

let clawAdapter: ClawCodeAdapter | null = null;
let ragClient: ClawCodeRAGClient | null = null;
const eventBridge = new ClawCodeEventBridge();

if (clawCodeConfig.enabled) {
  clawAdapter = new ClawCodeAdapter(clawCodeConfig);
  ragClient = new ClawCodeRAGClient(clawCodeConfig.ragUrl);
  const validation = await clawAdapter.validateConfig();
  if (validation.valid) {
    console.log('[orchestrator] claw-code adapter online');
  } else {
    console.warn('[orchestrator] claw-code adapter failed validation:', validation.error);
    clawAdapter = null;
  }
}
```

- [ ] **Step 3: Add RAG enrichment to agent dispatch**

In `src/orchestrator.ts`, inside the agent dispatch function (where prompts are built):

```typescript
// Before sending prompt to agent, enrich with RAG if available
async function enrichWithRAG(prompt: string): Promise<string> {
  if (!ragClient) return prompt;
  try {
    const ragHealth = await ragClient.health();
    if (!ragHealth) return prompt;

    const chunks = await ragClient.query(prompt, 3);
    if (chunks.length === 0) return prompt;

    const context = chunks.map(c => `[${c.source}] ${c.text}`).join('\n---\n');
    return `[RAG Context]\n${context}\n---\n\n${prompt}`;
  } catch {
    return prompt;
  }
}
```

- [ ] **Step 4: Verify build compiles**

Run: `npm run build`
Expected: Clean compile, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/orchestrator.ts
git commit -m "feat(claw-code): wire adapter + RAG enrichment into orchestrator dispatch"
```

---

### Task 7: Scheduler RAG Context Enrichment

**Files:**
- Modify: `src/scheduler.ts`

- [ ] **Step 1: Import RAG client in scheduler**

```typescript
// Add to imports in scheduler.ts
import { ClawCodeRAGClient } from './borg-arc/adapters/claw-code-rag';

// Initialize alongside existing context enrichment
const ragClient = process.env.CLAW_RAG_URL
  ? new ClawCodeRAGClient(process.env.CLAW_RAG_URL)
  : null;
```

- [ ] **Step 2: Add RAG enrichment to task dispatch**

Find the existing `enrichPrompt()` call in scheduler (from Phase 2 Path B context-injector work) and extend:

```typescript
// After existing enrichPrompt() call, add RAG layer
if (ragClient) {
  try {
    const ragHealth = await ragClient.health();
    if (ragHealth) {
      const chunks = await ragClient.query(enrichedPrompt, 3);
      if (chunks.length > 0) {
        const ragContext = chunks.map(c => `[${c.source}] ${c.text}`).join('\n---\n');
        enrichedPrompt = `[RAG Context]\n${ragContext}\n---\n\n${enrichedPrompt}`;
      }
    }
  } catch {
    // RAG unavailable, proceed without
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add src/scheduler.ts
git commit -m "feat(claw-code): add RAG context enrichment to scheduled task dispatch"
```

---

### Task 8: Agent Capability Flags

**Files:**
- Modify: `agents/main/agent.yaml`
- Modify: `agents/research/agent.yaml`
- Modify: `agents/comms/agent.yaml`
- Modify: `agents/content/agent.yaml`
- Modify: `agents/ops/agent.yaml`
- Modify: `agents/custom/agent.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Add claw_code capability to each agent config**

For each agent, add to capabilities list:

```yaml
# agents/main/agent.yaml -- Melanie (orchestrator)
capabilities:
  # ... existing capabilities
  - claw_code_dispatch    # Can dispatch tasks to claw-code Rust harness
  - claw_code_rag         # Can query RAG service for context
  - claw_code_health      # Can check claw-code system health

# agents/research/agent.yaml -- Annika
capabilities:
  - claw_code_rag         # Primary RAG consumer for research

# agents/comms/agent.yaml -- James
capabilities:
  - claw_code_rag         # RAG for outreach context

# agents/content/agent.yaml -- Melissa
capabilities:
  - claw_code_rag         # RAG for content research

# agents/ops/agent.yaml -- Sean
capabilities:
  - claw_code_health      # Monitor claw-code system health
  - claw_code_rag         # RAG for ops context

# agents/custom/agent.yaml -- Jackson
capabilities:
  - claw_code_rag         # RAG for CRM context
```

- [ ] **Step 2: Update .env.example**

```bash
# Claw-Code Integration (Rust Agent Harness)
# CLAW_CODE_BIN=/path/to/claw          # Path to compiled claw binary (enables adapter)
# CLAW_RAG_URL=http://localhost:8787    # RAG service endpoint
# CLAW_CODE_MODEL=claude-sonnet-4-20250514  # Default model for claw-code tasks
```

- [ ] **Step 3: Commit**

```bash
git add agents/*/agent.yaml .env.example
git commit -m "feat(claw-code): add capability flags to all 6 agents + env config"
```

---

## Phase 3: Compile Rust Binary (Tasks 9-10)

### Task 9: Build Script for Claw-Code Binary

**Files:**
- Create: `scripts/claw-code-build.sh`

- [ ] **Step 1: Write build script**

```bash
#!/usr/bin/env bash
# scripts/claw-code-build.sh
# Compile claw-code from fork into usable binary
set -euo pipefail

PROJECT_ROOT="${CLAUDECLAW_PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLAW_SRC="${PROJECT_ROOT}/forks/claw-code-collective/rust"
CLAW_BIN_DIR="${PROJECT_ROOT}/bin"

echo "[claw-code-build] Source: ${CLAW_SRC}"
echo "[claw-code-build] Target: ${CLAW_BIN_DIR}"

# Verify Rust toolchain
if ! command -v cargo &>/dev/null; then
  echo "ERROR: cargo not found. Install Rust: https://rustup.rs"
  exit 1
fi

echo "[claw-code-build] Rust: $(rustc --version)"
echo "[claw-code-build] Cargo: $(cargo --version)"

# Build release binary
cd "${CLAW_SRC}"
echo "[claw-code-build] Building release binary..."
cargo build --release --bin rusty-claude-cli 2>&1

# Copy binary
mkdir -p "${CLAW_BIN_DIR}"
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  cp target/release/rusty-claude-cli.exe "${CLAW_BIN_DIR}/claw.exe"
  echo "[claw-code-build] Binary: ${CLAW_BIN_DIR}/claw.exe"
else
  cp target/release/rusty-claude-cli "${CLAW_BIN_DIR}/claw"
  chmod +x "${CLAW_BIN_DIR}/claw"
  echo "[claw-code-build] Binary: ${CLAW_BIN_DIR}/claw"
fi

# Verify
"${CLAW_BIN_DIR}/claw" --version || "${CLAW_BIN_DIR}/claw.exe" --version
echo "[claw-code-build] Done."
```

- [ ] **Step 2: Commit**

```bash
chmod +x scripts/claw-code-build.sh
git add scripts/claw-code-build.sh
git commit -m "feat(claw-code): add Rust binary build script"
```

---

### Task 10: Build and Verify Binary

- [ ] **Step 1: Run build**

Run: `bash scripts/claw-code-build.sh`
Expected: Cargo compiles 9 crates, binary at `bin/claw.exe` (Windows) or `bin/claw` (Linux)

- [ ] **Step 2: Verify binary works**

Run: `./bin/claw --version`
Expected: Output containing `claw` and version number

- [ ] **Step 3: Run claw doctor**

Run: `./bin/claw doctor`
Expected: Health check output (RAG may show unavailable until Docker started)

- [ ] **Step 4: Add CLAW_CODE_BIN to .env**

```bash
echo 'CLAW_CODE_BIN=./bin/claw' >> .env
```

- [ ] **Step 5: Commit binary path config**

```bash
git add .env.example
git commit -m "feat(claw-code): binary compiled and verified"
```

---

## Phase 4: Compound -- Cross-Agent Integration (Tasks 11-13)

### Task 11: Wire RAG into Bot Interactive Path

**Files:**
- Modify: `src/bot.ts`

- [ ] **Step 1: Add RAG context to interactive Telegram messages**

In `src/bot.ts`, where user messages get processed and sent to agent:

```typescript
// Import RAG client
import { ClawCodeRAGClient } from './borg-arc/adapters/claw-code-rag';

const ragClient = process.env.CLAW_RAG_URL
  ? new ClawCodeRAGClient(process.env.CLAW_RAG_URL)
  : null;

// In message handler, before calling agent:
async function enrichUserMessage(message: string): Promise<string> {
  if (!ragClient) return message;
  try {
    const chunks = await ragClient.query(message, 2);
    if (chunks.length === 0) return message;
    const context = chunks.map(c => `[${c.source}] ${c.text}`).join('\n');
    return `[Workspace context]\n${context}\n---\n${message}`;
  } catch {
    return message;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat(claw-code): wire RAG context into Telegram bot interactive path"
```

---

### Task 12: Health Dashboard for Sean (Ops)

**Files:**
- Modify: `src/hive-cli.ts`

- [ ] **Step 1: Add claw-health command to hive-cli**

```typescript
// In hive-cli.ts command definitions, add:
case 'claw-health': {
  const ragUrl = process.env.CLAW_RAG_URL || 'http://localhost:8787';
  const binPath = process.env.CLAW_CODE_BIN || 'claw';

  // Check binary
  let binaryOk = false;
  let version = 'unknown';
  try {
    const out = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 5000 });
    binaryOk = true;
    version = out.trim();
  } catch { /* binary unavailable */ }

  // Check RAG
  let ragOk = false;
  let ragChunks = 0;
  try {
    const res = await fetch(`${ragUrl}/health`);
    ragOk = res.ok;
    if (ragOk) {
      const stats = await (await fetch(`${ragUrl}/v1/stats`)).json();
      ragChunks = stats.chunks || 0;
    }
  } catch { /* rag unavailable */ }

  console.log(`Claw-Code Health Report`);
  console.log(`  Binary: ${binaryOk ? 'OK' : 'MISSING'} (${version})`);
  console.log(`  RAG Service: ${ragOk ? 'OK' : 'DOWN'}`);
  console.log(`  RAG Chunks: ${ragChunks}`);
  console.log(`  Qdrant: ${ragOk ? 'OK (via RAG)' : 'UNKNOWN'}`);
  break;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/hive-cli.ts
git commit -m "feat(claw-code): add claw-health command to hive-cli for ops monitoring"
```

---

### Task 13: Integration Smoke Test

**Files:**
- Create: `scripts/claw-code-smoke-test.mjs`

- [ ] **Step 1: Write smoke test script**

```javascript
#!/usr/bin/env node
// scripts/claw-code-smoke-test.mjs
// Verifies claw-code integration is wired correctly

import { execSync } from 'child_process';

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT || '.';
const tests = [];

// Test 1: Binary exists
try {
  const bin = process.env.CLAW_CODE_BIN || 'claw';
  execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 5000 });
  tests.push({ name: 'Binary', status: 'PASS' });
} catch {
  tests.push({ name: 'Binary', status: 'FAIL', note: 'claw binary not found' });
}

// Test 2: TypeScript types compile
try {
  execSync('npx tsc --noEmit src/borg-arc/adapters/claw-code-types.ts', {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 30000,
  });
  tests.push({ name: 'Types compile', status: 'PASS' });
} catch {
  tests.push({ name: 'Types compile', status: 'FAIL' });
}

// Test 3: RAG service reachable
try {
  const ragUrl = process.env.CLAW_RAG_URL || 'http://localhost:8787';
  const res = await fetch(`${ragUrl}/health`);
  tests.push({ name: 'RAG health', status: res.ok ? 'PASS' : 'FAIL' });
} catch {
  tests.push({ name: 'RAG health', status: 'SKIP', note: 'RAG not running (optional)' });
}

// Test 4: Unit tests pass
try {
  execSync('npx vitest run tests/borg-arc/', {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000,
  });
  tests.push({ name: 'Unit tests', status: 'PASS' });
} catch {
  tests.push({ name: 'Unit tests', status: 'FAIL' });
}

// Report
console.log('\n=== Claw-Code Integration Smoke Test ===\n');
for (const t of tests) {
  const icon = t.status === 'PASS' ? 'OK' : t.status === 'SKIP' ? '--' : 'XX';
  console.log(`  [${icon}] ${t.name}${t.note ? ' (' + t.note + ')' : ''}`);
}

const passed = tests.filter(t => t.status === 'PASS').length;
const total = tests.length;
console.log(`\n  ${passed}/${total} passed\n`);

process.exit(tests.some(t => t.status === 'FAIL') ? 1 : 0);
```

- [ ] **Step 2: Run smoke test**

Run: `node scripts/claw-code-smoke-test.mjs`
Expected: Binary + Types + Unit tests PASS, RAG may SKIP if Docker not running

- [ ] **Step 3: Commit**

```bash
git add scripts/claw-code-smoke-test.mjs
git commit -m "feat(claw-code): add integration smoke test"
```

---

## Agent Benefit Map

| Agent | Claw-Code Benefit | Capability Flag |
|-------|------------------|-----------------|
| **Melanie** (orchestrator) | Dispatch Rust-speed tasks, monitor health, RAG context for routing decisions | dispatch + rag + health |
| **Annika** (research) | RAG queries across all forked repos + ClaudeClaw codebase for deep research | rag |
| **James** (comms) | RAG context for personalized outreach -- knows what we shipped | rag |
| **Sean** (ops) | Health monitoring via `claw-health` command, system status dashboards | health + rag |
| **Melissa** (content) | RAG-powered content research across codebase for technical posts | rag |
| **Jackson** (CRM) | RAG context for deal notes -- knows client audit history | rag |

## Dependency Graph

```
Task 1 (types) ─┬─> Task 2 (adapter) ─┬─> Task 6 (orchestrator wiring)
                 ├─> Task 3 (RAG client) ──> Task 7 (scheduler RAG)
                 └─> Task 4 (events)         Task 11 (bot RAG)
                                             Task 12 (health CLI)
Task 5 (docker) ─────────────────────────> Task 10 (build + verify)
Task 9 (build script) ─> Task 10
All tasks ─> Task 13 (smoke test)
```

## Prerequisites

- Rust toolchain: rustc 1.95.0, cargo 1.95.0 (CONFIRMED installed)
- Docker Desktop: required for RAG sidecar (Qdrant + claw-rag-service)
- ANTHROPIC_API_KEY in .env (required for claw-code execution)
- Node.js + npm (existing ClaudeClaw OS dependency)
