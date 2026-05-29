/**
 * Model Router — ClaudeClaw Collective
 *
 * Main entry point for model routing. Analyzes task prompts and returns
 * a RoutingDecision with recommended model tier and confidence.
 *
 * Usage:
 *   import { routeTask } from './model-routing/router.js';
 *   const decision = routeTask({ taskPrompt: "...", agent: "annika", priority: 7 });
 *   // decision.model -> 'opus' | 'sonnet' | 'haiku'
 */

import type {
  RoutingContext,
  RoutingDecision,
  ComplexityTier,
  ModelTier,
  CollectiveAgent,
} from './types.js';
import { TIER_TO_MODEL, AGENT_DEFAULT_TIERS } from './types.js';
import { extractAllSignals } from './signals.js';
import { calculateComplexityScore, scoreToTier, calculateConfidence } from './scorer.js';
import { evaluateRules } from './rules.js';

/**
 * Route a task to the appropriate model tier.
 *
 * Flow:
 * 1. Check explicit model override
 * 2. Extract complexity signals from prompt
 * 3. Evaluate priority-ordered rules
 * 4. Calculate weighted complexity score
 * 5. Resolve divergence between rules and scorer
 * 6. Return decision with confidence
 */
export function routeTask(context: RoutingContext): RoutingDecision {
  const reasons: string[] = [];

  // Explicit override bypasses everything
  if (context.explicitModel) {
    const tier = modelToTier(context.explicitModel);
    return {
      model: context.explicitModel,
      tier,
      confidence: 1.0,
      reasons: ['Explicit model override'],
      score: 0,
    };
  }

  // Extract signals
  const signals = extractAllSignals(context.taskPrompt, context);

  // Rules evaluation (priority-ordered, first match wins)
  const ruleResult = evaluateRules(context, signals);
  reasons.push(`Rule [${ruleResult.ruleName}]: ${ruleResult.reason}`);

  // Scorer evaluation (weighted aggregation)
  const score = calculateComplexityScore(signals);
  const scorerTier = scoreToTier(score);

  // Resolve: if rules and scorer agree, high confidence. If they diverge, take the higher tier.
  let finalTier: ComplexityTier;
  if (ruleResult.tier === scorerTier) {
    finalTier = ruleResult.tier;
    reasons.push(`Scorer agrees: score=${score}, tier=${scorerTier}`);
  } else {
    // Take whichever is higher (more conservative)
    finalTier = tierMax(ruleResult.tier, scorerTier);
    reasons.push(`Divergence: rule=${ruleResult.tier}, scorer=${scorerTier} (score=${score}). Escalated to ${finalTier}`);
  }

  const confidence = calculateConfidence(score, finalTier);

  return {
    model: TIER_TO_MODEL[finalTier],
    tier: finalTier,
    confidence,
    reasons,
    score,
  };
}

/**
 * Quick tier lookup for an agent with no task context.
 * Returns the agent's default tier from AGENT_DEFAULT_TIERS.
 */
export function quickTierForAgent(agent: CollectiveAgent): ModelTier {
  const tier = AGENT_DEFAULT_TIERS[agent] ?? 'MEDIUM';
  return TIER_TO_MODEL[tier];
}

/**
 * Analyze task complexity without making a routing decision.
 * Useful for logging/debugging.
 */
export function analyzeTaskComplexity(prompt: string, context?: Partial<RoutingContext>) {
  const fullContext: RoutingContext = { taskPrompt: prompt, ...context };
  const signals = extractAllSignals(prompt, fullContext);
  const score = calculateComplexityScore(signals);
  const tier = scoreToTier(score);
  const ruleResult = evaluateRules(fullContext, signals);

  return {
    signals,
    score,
    scorerTier: tier,
    ruleTier: ruleResult.tier,
    ruleName: ruleResult.ruleName,
    ruleReason: ruleResult.reason,
    finalTier: tierMax(tier, ruleResult.tier),
    model: TIER_TO_MODEL[tierMax(tier, ruleResult.tier)],
  };
}

// ---- Helpers ----

const TIER_ORDER: Record<ComplexityTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function tierMax(a: ComplexityTier, b: ComplexityTier): ComplexityTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

function modelToTier(model: ModelTier): ComplexityTier {
  switch (model) {
    case 'opus': return 'HIGH';
    case 'sonnet': return 'MEDIUM';
    case 'haiku': return 'LOW';
  }
}
