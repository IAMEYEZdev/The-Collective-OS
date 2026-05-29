/**
 * Context Injector — ClaudeClaw Collective
 *
 * Injects accumulated context into agent prompts using configurable strategies.
 * Consumes context after injection (one-shot by default).
 */

import type { ContextCollector } from './collector.js';
import type {
  InjectionStrategy,
  InjectionResult,
  OutputPart,
  RegisterContextOptions,
} from './types.js';

/**
 * Inject pending context into an array of OutputParts.
 * Finds the first text part and applies the injection strategy.
 * Consumes the context after injection.
 */
export function injectPendingContext(
  collector: ContextCollector,
  sessionId: string,
  parts: OutputPart[],
  strategy: InjectionStrategy = 'prepend'
): InjectionResult {
  if (!collector.hasPending(sessionId)) {
    return { injected: false, contextLength: 0, entryCount: 0 };
  }

  const pending = collector.consume(sessionId);
  if (!pending.hasContent) {
    return { injected: false, contextLength: 0, entryCount: 0 };
  }

  // Find first text part to inject into
  const textPart = parts.find(p => p.type === 'text' && p.text !== undefined);
  if (!textPart || textPart.text === undefined) {
    return { injected: false, contextLength: pending.merged.length, entryCount: pending.entries.length };
  }

  textPart.text = applyStrategy(textPart.text, pending.merged, strategy);

  return {
    injected: true,
    contextLength: pending.merged.length,
    entryCount: pending.entries.length,
  };
}

/**
 * Inject pending context into a raw text string.
 * Consumes the context after injection.
 */
export function injectContextIntoText(
  collector: ContextCollector,
  sessionId: string,
  text: string,
  strategy: InjectionStrategy = 'prepend'
): { text: string; result: InjectionResult } {
  if (!collector.hasPending(sessionId)) {
    return { text, result: { injected: false, contextLength: 0, entryCount: 0 } };
  }

  const pending = collector.consume(sessionId);
  if (!pending.hasContent) {
    return { text, result: { injected: false, contextLength: 0, entryCount: 0 } };
  }

  return {
    text: applyStrategy(text, pending.merged, strategy),
    result: {
      injected: true,
      contextLength: pending.merged.length,
      entryCount: pending.entries.length,
    },
  };
}

/**
 * Create a context injector interface for a specific session.
 * Convenience wrapper for use in agent prompt assembly.
 */
export function createSessionInjector(
  collector: ContextCollector,
  sessionId: string
) {
  return {
    /** Register context for this session */
    register(options: RegisterContextOptions): void {
      collector.register(sessionId, options);
    },

    /** Inject pending context into text */
    inject(
      text: string,
      strategy: InjectionStrategy = 'prepend'
    ): { text: string; result: InjectionResult } {
      return injectContextIntoText(collector, sessionId, text, strategy);
    },

    /** Inject into OutputParts array */
    injectParts(
      parts: OutputPart[],
      strategy: InjectionStrategy = 'prepend'
    ): InjectionResult {
      return injectPendingContext(collector, sessionId, parts, strategy);
    },

    /** Check if context is pending */
    hasPending(): boolean {
      return collector.hasPending(sessionId);
    },

    /** Clear all pending context */
    clear(): void {
      collector.clear(sessionId);
    },

    /** Get entry count */
    entryCount(): number {
      return collector.getEntryCount(sessionId);
    },
  };
}

// ---- Strategy implementation ----

function applyStrategy(
  original: string,
  context: string,
  strategy: InjectionStrategy
): string {
  switch (strategy) {
    case 'prepend':
      return `${context}\n\n${original}`;
    case 'append':
      return `${original}\n\n${context}`;
    case 'wrap':
      return `<injected-context>\n${context}\n</injected-context>\n\n${original}`;
  }
}
