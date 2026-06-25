/**
 * Context Collector — ClaudeClaw Collective
 *
 * Session-scoped context accumulator. Agents register context entries
 * which get sorted newest-first and merged for prompt injection.
 *
 * Key semantics:
 * - register() upserts by source:id composite key
 * - getPending() reads without clearing
 * - consume() reads and clears (one-shot)
 */

import type {
  ContextEntry,
  PendingContext,
  RegisterContextOptions,
  ContextSourceType,
} from './types.js';

/** Tunable cap for per-turn injected context, estimated at 4 chars/token. */
export const CONTEXT_INJECT_TOKEN_BUDGET = parseInt(
  process.env.CONTEXT_INJECT_TOKEN_BUDGET || '1500',
  10,
);

const CONTEXT_INJECT_CHAR_BUDGET = Math.max(0, CONTEXT_INJECT_TOKEN_BUDGET * 4);

export class ContextCollector {
  /** Map<sessionId, Map<"source:id", ContextEntry>> */
  private sessions = new Map<string, Map<string, ContextEntry>>();

  /** Register or update a context entry for a session */
  register(sessionId: string, options: RegisterContextOptions): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Map();
      this.sessions.set(sessionId, session);
    }

    const key = `${options.source}:${options.id}`;
    const entry: ContextEntry = {
      id: options.id,
      source: options.source,
      content: options.content,
      priority: options.priority ?? 'normal',
      timestamp: Date.now(),
      metadata: options.metadata,
    };

    session.set(key, entry);
  }

  /** Get pending context without consuming it */
  getPending(sessionId: string): PendingContext {
    const session = this.sessions.get(sessionId);
    if (!session || session.size === 0) {
      return { merged: '', entries: [], hasContent: false };
    }

    const entries = this.capEntries(this.sortEntries(Array.from(session.values())));
    const merged = entries.map(e => e.content).join('\n\n');

    return { merged, entries, hasContent: true };
  }

  /** Get pending context and clear it (one-shot read) */
  consume(sessionId: string): PendingContext {
    const pending = this.getPending(sessionId);
    this.clear(sessionId);
    return pending;
  }

  /** Clear all entries for a session */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Check if session has pending context */
  hasPending(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && session.size > 0;
  }

  /** Remove a specific entry */
  removeEntry(sessionId: string, source: ContextSourceType, id: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const key = `${source}:${id}`;
    return session.delete(key);
  }

  /** Get count of entries for a session */
  getEntryCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  /** List all active session IDs */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Sort entries newest first so capped context preserves recent activity. */
  private sortEntries(entries: ContextEntry[]): ContextEntry[] {
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Keep newest entries within the injected-context budget. */
  private capEntries(entries: ContextEntry[]): ContextEntry[] {
    if (CONTEXT_INJECT_CHAR_BUDGET === 0) return [];

    const capped: ContextEntry[] = [];
    let used = 0;

    for (const entry of entries) {
      const separatorLength = capped.length > 0 ? 2 : 0;
      const remaining = CONTEXT_INJECT_CHAR_BUDGET - used - separatorLength;
      if (remaining <= 0) break;

      if (entry.content.length <= remaining) {
        capped.push(entry);
        used += separatorLength + entry.content.length;
        continue;
      }

      capped.push({
        ...entry,
        content: entry.content.slice(0, remaining),
      });
      break;
    }

    return capped;
  }
}

/** Global singleton collector */
export const contextCollector = new ContextCollector();
