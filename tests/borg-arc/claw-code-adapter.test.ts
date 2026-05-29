// tests/borg-arc/claw-code-adapter.test.ts
import { describe, it, expect, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// Adapter tests (Task 2)
// ---------------------------------------------------------------------------

import { ClawCodeAdapter } from '../../src/borg-arc/adapters/claw-code-adapter';
import { AdapterFactory, EventStatus, Severity } from '../../src/borg-arc/adapters/adapter';
import type { ProviderConfig } from '../../src/borg-arc/adapters/adapter';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('ClawCodeAdapter', () => {
  const mockClawConfig: ClawCodeConfig = {
    binPath: '/usr/local/bin/claw',
    ragUrl: 'http://localhost:8787',
    anthropicApiKey: 'sk-ant-test',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultPermissionMode: 'sandboxed',
    timeoutMs: 300000,
  };

  const mockProviderConfig: ProviderConfig = {
    name: 'claw-code-test',
    authentication: {},
  };

  it('validateClawConfig checks binary exists', async () => {
    vi.mocked(execSync).mockReturnValue('claw 0.1.3' as unknown as Buffer);
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const result = await adapter.validateClawConfig();
    expect(result.valid).toBe(true);
  });

  it('validateClawConfig fails when binary missing', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const result = await adapter.validateClawConfig();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('binary');
  });

  it('clawHealthCheck returns structured status', async () => {
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({
        binary: true,
        version: '0.1.3',
        rag: true,
        qdrant: true,
      }) as unknown as Buffer,
    );
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const health = await adapter.clawHealthCheck();
    expect(health.binary).toBe(true);
    expect(health.version).toBe('0.1.3');
  });

  it('healthCheck returns standard HealthCheckResult', async () => {
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({
        binary: true,
        version: '0.1.3',
        rag: true,
        qdrant: true,
      }) as unknown as Buffer,
    );
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('0.1.3');
    expect(health.checkedAt).toBeTruthy();
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
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify(mockResponse) as unknown as Buffer,
    );

    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const result = await adapter.execute({
      prompt: 'say hello',
      model: 'claude-sonnet-4-20250514',
      outputFormat: 'json',
      tools: [],
      permissionMode: 'sandboxed',
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('Hello world');
  });

  it('execute returns error response on failure', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('binary crashed');
    });

    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const result = await adapter.execute({
      prompt: 'fail',
      model: 'claude-sonnet-4-20250514',
      outputFormat: 'json',
      tools: [],
      permissionMode: 'sandboxed',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('binary crashed');
  });

  it('formatEvent converts response to NormalizedEvent', () => {
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const event = adapter.formatEvent({
      id: 'sess_123',
      status: 'completed',
      output: 'task done',
      toolsUsed: ['bash'],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      durationMs: 1500,
    });
    expect(event).not.toBeNull();
    expect(event!.name).toBe('claw-code:completed');
    expect(event!.status).toBe(EventStatus.RESOLVED);
    expect(event!.severity).toBe(Severity.INFO);
    expect(event!.source).toContain('claw-code');
  });

  it('formatEvent returns FIRING + CRITICAL for failed status', () => {
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    const event = adapter.formatEvent({
      id: 'sess_fail',
      status: 'failed',
      output: '',
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
      error: 'something broke',
    });
    expect(event).not.toBeNull();
    expect(event!.status).toBe(EventStatus.FIRING);
    expect(event!.severity).toBe(Severity.CRITICAL);
  });

  it('dispose resolves without error', async () => {
    const adapter = new ClawCodeAdapter(mockProviderConfig, mockClawConfig);
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});
