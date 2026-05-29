/**
 * Context Injector Types — ClaudeClaw Collective
 *
 * Adapted from oh-my-claudecode's context-injector.
 * Manages session-scoped context enrichment for agent prompts.
 */

/** Sources of injected context in the Collective */
export type ContextSourceType =
  | 'hive-mind'          // Cross-agent activity log
  | 'operator-context'   // Jason's directives, preferences, standing rules
  | 'memory-context'     // SQLite memory recall (facts, history)
  | 'team-activity'      // Other agents' recent actions/status
  | 'agent-directives'   // Per-agent CLAUDE.md / standing instructions
  | 'mission-state'      // Current mission/task context
  | 'routing-decision'   // Model routing rationale
  | 'session-context'    // Ongoing session state
  | 'custom';            // Ad-hoc injections

/** Priority levels for context entries */
export type ContextPriority = 'critical' | 'high' | 'normal' | 'low';

/** Priority sort order (lower number = higher priority) */
export const PRIORITY_ORDER: Record<ContextPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** A single context entry ready for injection */
export interface ContextEntry {
  id: string;
  source: ContextSourceType;
  content: string;
  priority: ContextPriority;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Options for registering context */
export interface RegisterContextOptions {
  id: string;
  source: ContextSourceType;
  content: string;
  priority?: ContextPriority;
  metadata?: Record<string, unknown>;
}

/** Merged pending context for a session */
export interface PendingContext {
  /** All entries merged into a single string, priority-sorted */
  merged: string;
  /** Individual entries, priority-sorted */
  entries: ContextEntry[];
  /** Whether any content exists */
  hasContent: boolean;
}

/** How to inject context into the prompt */
export type InjectionStrategy = 'prepend' | 'append' | 'wrap';

/** Result of an injection operation */
export interface InjectionResult {
  injected: boolean;
  contextLength: number;
  entryCount: number;
}

/** Text part for message processing (compatible with hook output) */
export interface OutputPart {
  type: string;
  text?: string;
}
