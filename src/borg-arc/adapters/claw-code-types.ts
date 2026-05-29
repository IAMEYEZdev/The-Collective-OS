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
