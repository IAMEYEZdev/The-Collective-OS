/**
 * Complexity Scorer — ClaudeClaw Collective
 *
 * Weighted scoring to determine LOW/MEDIUM/HIGH complexity tier.
 * Adapted from oh-my-claudecode with Collective-specific weights
 * (revenue keywords, priority escalation).
 */

import type {
  ComplexitySignals,
  ComplexityTier,
  LexicalSignals,
  StructuralSignals,
  ContextSignals,
} from './types.js';

/** Score thresholds for tier classification */
const THRESHOLDS = {
  HIGH: 8,    // >= 8 -> opus
  MEDIUM: 4,  // >= 4 -> sonnet
  // < 4 -> haiku
};

/** Weight configuration */
const W = {
  lexical: {
    wordCountHigh: 2,
    wordCountVeryHigh: 1,
    filePathsMultiple: 1,
    codeBlocks: 1,
    architecture: 3,
    debugging: 2,
    simple: -2,
    risk: 2,
    revenue: 1,           // Collective: revenue-adjacent tasks bump slightly
    questionWhy: 2,
    questionHow: 1,
    implicitReqs: 1,
  },
  structural: {
    subtasksMany: 3,
    subtasksSome: 1,
    crossFile: 2,
    testRequired: 1,
    securityDomain: 2,
    salesDomain: 1,       // Collective: sales/CRM tasks get slight bump
    externalKnowledge: 1,
    reversibilityDifficult: 2,
    reversibilityModerate: 1,
    impactSystemWide: 3,
    impactModule: 1,
  },
  context: {
    previousFailure: 2,
    previousFailureMax: 4,
    highPriority: 2,      // Collective: priority >= 8 bumps tier
    deepChain: 2,
  },
};

function scoreLexical(s: LexicalSignals): number {
  let score = 0;
  if (s.wordCount > 200) { score += W.lexical.wordCountHigh; }
  if (s.wordCount > 500) { score += W.lexical.wordCountVeryHigh; }
  if (s.filePathCount >= 2) { score += W.lexical.filePathsMultiple; }
  if (s.codeBlockCount > 0) { score += W.lexical.codeBlocks; }
  if (s.hasArchitectureKeywords) { score += W.lexical.architecture; }
  if (s.hasDebuggingKeywords) { score += W.lexical.debugging; }
  if (s.hasSimpleKeywords) { score += W.lexical.simple; }
  if (s.hasRiskKeywords) { score += W.lexical.risk; }
  if (s.hasRevenueKeywords) { score += W.lexical.revenue; }
  if (s.questionDepth === 'why') { score += W.lexical.questionWhy; }
  else if (s.questionDepth === 'how') { score += W.lexical.questionHow; }
  if (s.hasImplicitRequirements) { score += W.lexical.implicitReqs; }
  return score;
}

function scoreStructural(s: StructuralSignals): number {
  let score = 0;
  if (s.estimatedSubtasks > 3) { score += W.structural.subtasksMany; }
  else if (s.estimatedSubtasks > 1) { score += W.structural.subtasksSome; }
  if (s.crossFileDependencies) { score += W.structural.crossFile; }
  if (s.hasTestRequirements) { score += W.structural.testRequired; }
  if (s.domainSpecificity === 'security') { score += W.structural.securityDomain; }
  if (s.domainSpecificity === 'sales') { score += W.structural.salesDomain; }
  if (s.requiresExternalKnowledge) { score += W.structural.externalKnowledge; }
  if (s.reversibility === 'difficult') { score += W.structural.reversibilityDifficult; }
  else if (s.reversibility === 'moderate') { score += W.structural.reversibilityModerate; }
  if (s.impactScope === 'system-wide') { score += W.structural.impactSystemWide; }
  else if (s.impactScope === 'module') { score += W.structural.impactModule; }
  return score;
}

function scoreContext(s: ContextSignals): number {
  let score = 0;
  score += Math.min(s.previousFailures * W.context.previousFailure, W.context.previousFailureMax);
  if (s.priority >= 8) { score += W.context.highPriority; }
  if (s.agentChainDepth >= 3) { score += W.context.deepChain; }
  return score;
}

/** Calculate total complexity score */
export function calculateComplexityScore(signals: ComplexitySignals): number {
  return scoreLexical(signals.lexical)
    + scoreStructural(signals.structural)
    + scoreContext(signals.context);
}

/** Convert score to tier */
export function scoreToTier(score: number): ComplexityTier {
  if (score >= THRESHOLDS.HIGH) return 'HIGH';
  if (score >= THRESHOLDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/** Calculate tier from signals */
export function calculateComplexityTier(signals: ComplexitySignals): ComplexityTier {
  return scoreToTier(calculateComplexityScore(signals));
}

/** Confidence in tier assignment (0-1). Higher when far from thresholds. */
export function calculateConfidence(score: number, tier: ComplexityTier): number {
  let minDistance: number;
  switch (tier) {
    case 'LOW':
      minDistance = THRESHOLDS.MEDIUM - score;
      break;
    case 'MEDIUM':
      minDistance = Math.min(
        Math.abs(score - THRESHOLDS.MEDIUM),
        Math.abs(score - THRESHOLDS.HIGH)
      );
      break;
    case 'HIGH':
      minDistance = score - THRESHOLDS.HIGH;
      break;
  }
  return Math.round((0.5 + (Math.min(minDistance, 4) / 4) * 0.4) * 100) / 100;
}

/** Score breakdown for debugging */
export function getScoreBreakdown(signals: ComplexitySignals) {
  const lexical = scoreLexical(signals.lexical);
  const structural = scoreStructural(signals.structural);
  const context = scoreContext(signals.context);
  const total = lexical + structural + context;
  return { lexical, structural, context, total, tier: scoreToTier(total) };
}
