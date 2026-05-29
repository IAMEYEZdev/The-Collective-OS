/**
 * Claw-Code Borg Arc Adapter
 *
 * Bridges ClaudeClaw's orchestrator to the claw-code Rust binary
 * via subprocess IPC (JSON over stdin/stdout). Provides:
 *   - Binary validation and health checks
 *   - Prompt execution with timeout and error handling
 *   - NormalizedEvent formatting for hive integration
 *   - AdapterFactory registration
 */

import { execSync } from 'node:child_process';
import {
  BaseAdapter,
  AdapterFactory,
  EventStatus,
  Severity,
  type NormalizedEvent,
  type ProviderConfig,
  type HealthCheckResult,
} from './adapter.js';
import type {
  ClawCodeConfig,
  ClawCodeRequest,
  ClawCodeResponse,
  ClawCodeHealthStatus,
} from './claw-code-types.js';

// ---------------------------------------------------------------------------
// Validation result (internal -- BaseAdapter.validateConfig is void/throws)
// ---------------------------------------------------------------------------

export interface ClawCodeValidationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// ClawCodeAdapter
// ---------------------------------------------------------------------------

export class ClawCodeAdapter extends BaseAdapter {
  static override FINGERPRINT_FIELDS = ['id', 'status'];

  private clawConfig: ClawCodeConfig;

  constructor(config: ProviderConfig, clawConfig: ClawCodeConfig) {
    // BaseAdapter constructor calls validateConfig(), so clawConfig
    // must be set before super(). We use a two-phase init trick:
    // assign to a temporary field, then call super which triggers validate.
    // TypeScript strict mode requires definite assignment, so we pre-assign.
    // However, super() must be called first. We work around this by
    // allowing validateConfig to be a no-op on first call (config not yet set)
    // and doing explicit validation after.
    super(config);
    this.clawConfig = clawConfig;
  }

  // -- BaseAdapter abstract implementations ----------------------------------

  validateConfig(): void {
    // Called by BaseAdapter constructor before clawConfig is set.
    // Full validation is done via validateClawConfig() after construction.
    if (!this.clawConfig) return;

    if (!this.clawConfig.binPath) {
      throw new Error('ClawCodeAdapter: binPath is required');
    }
    if (!this.clawConfig.anthropicApiKey) {
      throw new Error('ClawCodeAdapter: anthropicApiKey is required');
    }
  }

  async dispose(): Promise<void> {
    // No persistent subprocess to tear down in sync execution mode.
  }

  // -- Claw-code specific methods -------------------------------------------

  /**
   * Check that the claw binary exists and responds to --version.
   * Returns a structured result instead of throwing.
   */
  async validateClawConfig(): Promise<ClawCodeValidationResult> {
    try {
      const out = execSync(`"${this.clawConfig.binPath}" --version`, {
        timeout: 5000,
        encoding: 'utf-8',
      });
      if (!out.includes('claw')) {
        return { valid: false, error: 'binary exists but not claw-code' };
      }
      return { valid: true };
    } catch {
      return {
        valid: false,
        error: `claw-code binary not found at ${this.clawConfig.binPath}`,
      };
    }
  }

  /**
   * Run `claw doctor` to get full system health including RAG + Qdrant.
   */
  async clawHealthCheck(): Promise<ClawCodeHealthStatus> {
    try {
      const out = execSync(
        `"${this.clawConfig.binPath}" doctor --output-format json`,
        {
          timeout: 10000,
          encoding: 'utf-8',
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: this.clawConfig.anthropicApiKey,
          },
        },
      );
      const parsed = JSON.parse(out);
      return {
        binary: true,
        version: parsed.version || 'unknown',
        ragService: parsed.rag ?? false,
        ragChunks: parsed.ragChunks ?? 0,
        qdrant: parsed.qdrant ?? false,
      };
    } catch {
      return {
        binary: false,
        version: 'unreachable',
        ragService: false,
        ragChunks: 0,
        qdrant: false,
      };
    }
  }

  /**
   * Override BaseAdapter.healthCheck to return standard HealthCheckResult
   * by delegating to clawHealthCheck().
   */
  override async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    const status = await this.clawHealthCheck();
    return {
      healthy: status.binary,
      latencyMs: Date.now() - start,
      message: status.binary
        ? `claw-code ${status.version} online`
        : 'claw-code binary unreachable',
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Execute a prompt via the claw-code binary (synchronous subprocess).
   */
  async execute(request: ClawCodeRequest): Promise<ClawCodeResponse> {
    try {
      const args = [
        'prompt',
        `"${request.prompt.replace(/"/g, '\\"')}"`,
        '--model',
        request.model,
        '--output-format',
        request.outputFormat,
      ];

      if (request.workspaceRoot) {
        args.push('--workspace', request.workspaceRoot);
      }

      if (request.permissionMode) {
        args.push('--permission-mode', request.permissionMode);
      }

      for (const tool of request.tools) {
        args.push('--tool', tool);
      }

      const out = execSync(
        `"${this.clawConfig.binPath}" ${args.join(' ')}`,
        {
          timeout: this.clawConfig.timeoutMs,
          encoding: 'utf-8',
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: this.clawConfig.anthropicApiKey,
          },
        },
      );

      return JSON.parse(out) as ClawCodeResponse;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'unknown execution error';
      return {
        id: 'error',
        status: 'failed',
        output: '',
        toolsUsed: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        durationMs: 0,
        error: message,
      };
    }
  }

  /**
   * Format a ClawCodeResponse into a NormalizedEvent for the Borg Arc pipeline.
   */
  override formatEvent(
    rawPayload: Record<string, unknown>,
  ): NormalizedEvent | null {
    const response = rawPayload as unknown as ClawCodeResponse;
    if (!response.id || !response.status) return null;

    return {
      id: response.id,
      name: `claw-code:${response.status}`,
      status:
        response.status === 'completed'
          ? EventStatus.RESOLVED
          : EventStatus.FIRING,
      severity:
        response.status === 'failed' ? Severity.CRITICAL : Severity.INFO,
      source: ['claw-code'],
      description: response.output?.slice(0, 200) ?? '',
      labels: {
        adapter: 'claw-code',
        responseStatus: response.status,
      },
      fingerprint: `claw-code:${response.id}`,
      lastReceived: new Date().toISOString(),
      raw: rawPayload,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

AdapterFactory.register({
  type: 'claw-code',
  displayName: 'Claw-Code (Rust Agent Harness)',
  categories: ['Developer Tools'],
  tags: ['data'],
  scopes: [],
  ctor: ClawCodeAdapter as unknown as new (
    config: ProviderConfig,
  ) => BaseAdapter,
});
