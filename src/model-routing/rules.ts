/**
 * Routing Rules — ClaudeClaw Collective
 *
 * Priority-ordered rules engine. First matching rule wins.
 * Adapted from oh-my-claudecode with Collective agent roles.
 */

import type {
  RoutingRule,
  RoutingContext,
  ComplexitySignals,
  ComplexityTier,
} from './types.js';

/** Default routing rules, highest priority first */
export const DEFAULT_RULES: RoutingRule[] = [
  // ---- Explicit override ----
  {
    name: 'explicit-model',
    condition: (ctx) => ctx.explicitModel !== undefined,
    action: { tier: 'HIGH', reason: 'Explicit model override' },
    priority: 100,
  },

  // ---- Agent-specific adaptive rules ----

  // Melanie (orchestrator): strategic routing always HIGH, simple status checks LOW
  {
    name: 'melanie-strategic',
    condition: (ctx, sig) =>
      ctx.agent === 'melanie' &&
      (sig.lexical.hasArchitectureKeywords ||
       sig.lexical.hasRiskKeywords ||
       sig.structural.impactScope === 'system-wide'),
    action: { tier: 'HIGH', reason: 'Melanie: strategic orchestration decision' },
    priority: 85,
  },
  {
    name: 'melanie-status-check',
    condition: (ctx, sig) =>
      ctx.agent === 'melanie' &&
      sig.lexical.hasSimpleKeywords &&
      !sig.lexical.hasRiskKeywords &&
      sig.structural.impactScope === 'local',
    action: { tier: 'LOW', reason: 'Melanie: simple status check' },
    priority: 80,
  },

  // Annika (research): deep analysis HIGH, simple lookups LOW
  {
    name: 'annika-deep-research',
    condition: (ctx, sig) =>
      ctx.agent === 'annika' &&
      (sig.lexical.hasDebuggingKeywords ||
       sig.lexical.questionDepth === 'why' ||
       sig.structural.requiresExternalKnowledge),
    action: { tier: 'HIGH', reason: 'Annika: deep research/analysis' },
    priority: 85,
  },
  {
    name: 'annika-domain-research',
    condition: (ctx, sig) =>
      ctx.agent === 'annika' &&
      sig.structural.domainSpecificity === 'research',
    action: { tier: 'MEDIUM', reason: 'Annika: research-domain task' },
    priority: 82,
  },
  {
    name: 'annika-simple-lookup',
    condition: (ctx, sig) =>
      ctx.agent === 'annika' &&
      sig.lexical.hasSimpleKeywords &&
      !sig.lexical.hasDebuggingKeywords &&
      sig.structural.estimatedSubtasks <= 1 &&
      sig.structural.domainSpecificity !== 'research',
    action: { tier: 'LOW', reason: 'Annika: simple data lookup' },
    priority: 80,
  },

  // Jackson (CRM): revenue-critical HIGH, routine pipeline MEDIUM
  {
    name: 'jackson-revenue-critical',
    condition: (ctx, sig) =>
      ctx.agent === 'jackson' &&
      sig.lexical.hasRevenueKeywords &&
      sig.lexical.hasRiskKeywords,
    action: { tier: 'HIGH', reason: 'Jackson: revenue-critical decision' },
    priority: 85,
  },

  // ---- Priority escalation ----
  {
    name: 'critical-priority',
    condition: (ctx) => (ctx.priority ?? 5) >= 8,
    action: { tier: 'HIGH', reason: 'Critical priority task (>= 8)' },
    priority: 75,
  },

  // ---- Task-based rules ----
  {
    name: 'architecture-system-wide',
    condition: (_, sig) =>
      sig.lexical.hasArchitectureKeywords &&
      sig.structural.impactScope === 'system-wide',
    action: { tier: 'HIGH', reason: 'Architecture decisions with system-wide impact' },
    priority: 70,
  },
  {
    name: 'security-domain',
    condition: (_, sig) => sig.structural.domainSpecificity === 'security',
    action: { tier: 'HIGH', reason: 'Security tasks require careful reasoning' },
    priority: 70,
  },
  {
    name: 'difficult-reversibility-risk',
    condition: (_, sig) =>
      sig.structural.reversibility === 'difficult' &&
      sig.lexical.hasRiskKeywords,
    action: { tier: 'HIGH', reason: 'High-risk, difficult-to-reverse changes' },
    priority: 70,
  },
  {
    name: 'deep-debugging',
    condition: (_, sig) =>
      sig.lexical.hasDebuggingKeywords &&
      sig.lexical.questionDepth === 'why',
    action: { tier: 'HIGH', reason: 'Root cause analysis' },
    priority: 65,
  },
  {
    name: 'complex-multi-step',
    condition: (_, sig) =>
      sig.structural.estimatedSubtasks > 5 &&
      sig.structural.crossFileDependencies,
    action: { tier: 'HIGH', reason: 'Complex multi-step task with cross-file changes' },
    priority: 60,
  },
  {
    name: 'simple-search',
    condition: (_, sig) =>
      sig.lexical.hasSimpleKeywords &&
      sig.structural.estimatedSubtasks <= 1 &&
      sig.structural.impactScope === 'local' &&
      !sig.lexical.hasArchitectureKeywords &&
      !sig.lexical.hasDebuggingKeywords,
    action: { tier: 'LOW', reason: 'Simple search/lookup' },
    priority: 60,
  },
  {
    name: 'short-local-change',
    condition: (_, sig) =>
      sig.lexical.wordCount < 50 &&
      sig.structural.impactScope === 'local' &&
      sig.structural.reversibility === 'easy' &&
      !sig.lexical.hasRiskKeywords,
    action: { tier: 'LOW', reason: 'Short, local, easily reversible' },
    priority: 55,
  },
  {
    name: 'moderate-complexity',
    condition: (_, sig) =>
      sig.structural.estimatedSubtasks > 1 &&
      sig.structural.estimatedSubtasks <= 5,
    action: { tier: 'MEDIUM', reason: 'Moderate complexity' },
    priority: 50,
  },
  {
    name: 'module-level',
    condition: (_, sig) => sig.structural.impactScope === 'module',
    action: { tier: 'MEDIUM', reason: 'Module-level changes' },
    priority: 45,
  },

  // ---- Default ----
  {
    name: 'default-medium',
    condition: () => true,
    action: { tier: 'MEDIUM', reason: 'Default tier' },
    priority: 0,
  },
];

/** Evaluate rules, return first match */
export function evaluateRules(
  context: RoutingContext,
  signals: ComplexitySignals,
  rules: RoutingRule[] = DEFAULT_RULES
): { tier: ComplexityTier; reason: string; ruleName: string } {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    if (rule.condition(context, signals)) {
      return { tier: rule.action.tier, reason: rule.action.reason, ruleName: rule.name };
    }
  }

  return { tier: 'MEDIUM', reason: 'Fallback', ruleName: 'fallback' };
}
