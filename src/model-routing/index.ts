/**
 * Model Routing — ClaudeClaw Collective
 *
 * Public API surface. Import from here.
 *
 * Usage:
 *   import { routeTask, quickTierForAgent, analyzeTaskComplexity } from './model-routing/index.js';
 */

export { routeTask, quickTierForAgent, analyzeTaskComplexity } from './router.js';
export type {
  RoutingContext,
  RoutingDecision,
  ComplexityTier,
  ModelTier,
  CollectiveAgent,
  ComplexitySignals,
  LexicalSignals,
  StructuralSignals,
  ContextSignals,
  RoutingRule,
} from './types.js';
export { TIER_TO_MODEL, AGENT_DEFAULT_TIERS, COMPLEXITY_KEYWORDS } from './types.js';
