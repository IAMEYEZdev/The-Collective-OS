/**
 * Context Collector — ClaudeClaw Collective
 *
 * Session-scoped context accumulator. Agents register context entries
 * which get priority-sorted and merged for prompt injection.
 *
 * Key semantics:
 * - register() upserts by source:id composite key
 * - getPending() reads without clearing
 * - consume() reads and clears (one-shot)
 */

import type {
  ContextEntry,
  ContextPriority,
  PendingContext,
  RegisterContextOptions,
  ContextSourceType,
} from './types.js';
import { PRIORITY_ORDER } from './types.js';

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

    const entries = this.sortEntries(Array.from(session.values()));
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

  /** Sort entries: critical > high > normal > low, then by timestamp ascending */
  private sortEntries(entries: ContextEntry[]): ContextEntry[] {
    return entries.sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.timestamp - b.timestamp;
    });
  }
}

/** Global singleton collector */
export const contextCollector = new ContextCollector();
