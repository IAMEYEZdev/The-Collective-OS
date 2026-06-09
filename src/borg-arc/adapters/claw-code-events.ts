// src/borg-arc/adapters/claw-code-events.ts
import type { ClawCodeTelemetryEvent } from './claw-code-types.js';

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
