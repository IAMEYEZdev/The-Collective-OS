/**
 * Context Injector — Public API
 *
 * Session-scoped context enrichment for Collective agent prompts.
 *
 * Usage:
 *   import { contextCollector, createSessionInjector } from './context-injector/index.js';
 *
 *   // Register context from various sources
 *   contextCollector.register(sessionId, {
 *     id: 'hive-latest',
 *     source: 'hive-mind',
 *     content: 'Recent team activity...',
 *     priority: 'normal',
 *   });
 *
 *   // Inject into agent prompt (consumes on read)
 *   const { text, result } = injectContextIntoText(
 *     contextCollector, sessionId, agentPrompt, 'wrap'
 *   );
 *
 *   // Or use session-scoped convenience wrapper
 *   const injector = createSessionInjector(contextCollector, sessionId);
 *   injector.register({ id: 'memory', source: 'memory-context', content: '...' });
 *   const enriched = injector.inject(prompt, 'prepend');
 */

// Types
export type {
  ContextSourceType,
  ContextPriority,
  ContextEntry,
  RegisterContextOptions,
  PendingContext,
  InjectionStrategy,
  InjectionResult,
  OutputPart,
} from './types.js';

export { PRIORITY_ORDER } from './types.js';

// Collector
export { ContextCollector, contextCollector } from './collector.js';

// Injector
export {
  injectPendingContext,
  injectContextIntoText,
  createSessionInjector,
} from './injector.js';

// Enricher (auto-populate + inject for dispatch)
export { enrichPrompt, type EnrichmentResult } from './enricher.js';
