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
