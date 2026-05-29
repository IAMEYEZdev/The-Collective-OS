/**
 * Model Routing Types — ClaudeClaw Collective
 *
 * Adapted from oh-my-claudecode's model-routing system.
 * Routes mission tasks to appropriate model tiers (opus/sonnet/haiku)
 * based on task complexity signals.
 */

/** Model tier identifiers */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

/** Complexity tier for task routing */
export type ComplexityTier = 'LOW' | 'MEDIUM' | 'HIGH';

/** Collective agent names */
export type CollectiveAgent =
  | 'melanie'
  | 'annika'
  | 'james'
  | 'sean'
  | 'melissa'
  | 'jackson'
  | 'main';

/** Tier to model mapping */
export const TIER_TO_MODEL: Record<ComplexityTier, ModelTier> = {
  LOW: 'haiku',
  MEDIUM: 'sonnet',
  HIGH: 'opus',
};

/** Default agent tier assignments based on role */
export const AGENT_DEFAULT_TIERS: Record<CollectiveAgent, ComplexityTier> = {
  melanie: 'HIGH',    // Orchestrator: strategic decisions
  annika: 'HIGH',     // Research: deep analysis
  james: 'MEDIUM',    // Comms: written voice
  sean: 'MEDIUM',     // Ops: scheduling, tracking
  melissa: 'MEDIUM',  // Content: production
  jackson: 'MEDIUM',  // CRM: pipeline ops
  main: 'MEDIUM',     // Default
};

/** Lexical signals extracted from task prompt */
export interface LexicalSignals {
  wordCount: number;
  filePathCount: number;
  codeBlockCount: number;
  hasArchitectureKeywords: boolean;
  hasDebuggingKeywords: boolean;
  hasSimpleKeywords: boolean;
  hasRiskKeywords: boolean;
  hasRevenueKeywords: boolean;
  questionDepth: 'why' | 'how' | 'what' | 'where' | 'none';
  hasImplicitRequirements: boolean;
}

/** Structural signals from task analysis */
export interface StructuralSignals {
  estimatedSubtasks: number;
  crossFileDependencies: boolean;
  hasTestRequirements: boolean;
  domainSpecificity: 'generic' | 'content' | 'research' | 'sales' | 'ops' | 'security';
  requiresExternalKnowledge: boolean;
  reversibility: 'easy' | 'moderate' | 'difficult';
  impactScope: 'local' | 'module' | 'system-wide';
}

/** Context signals from mission state */
export interface ContextSignals {
  previousFailures: number;
  priority: number;
  agentChainDepth: number;
}

/** Combined complexity signals */
export interface ComplexitySignals {
  lexical: LexicalSignals;
  structural: StructuralSignals;
  context: ContextSignals;
}

/** Routing decision result */
export interface RoutingDecision {
  model: ModelTier;
  tier: ComplexityTier;
  confidence: number;
  reasons: string[];
  score: number;
}

/** Context for making routing decisions */
export interface RoutingContext {
  taskPrompt: string;
  agent?: CollectiveAgent;
  priority?: number;
  previousFailures?: number;
  agentChainDepth?: number;
  explicitModel?: ModelTier;
}

/** Routing rule definition */
export interface RoutingRule {
  name: string;
  condition: (ctx: RoutingContext, signals: ComplexitySignals) => boolean;
  action: { tier: ComplexityTier; reason: string };
  priority: number;
}

/** Complexity keyword groups */
export const COMPLEXITY_KEYWORDS = {
  architecture: [
    'architecture', 'refactor', 'redesign', 'restructure', 'reorganize',
    'decouple', 'modularize', 'abstract', 'pattern', 'design system',
  ],
  debugging: [
    'debug', 'diagnose', 'root cause', 'investigate', 'trace', 'analyze',
    'why is', 'figure out', 'understand why', 'not working', 'broken',
  ],
  simple: [
    'find', 'search', 'locate', 'list', 'show', 'where is', 'what is',
    'get', 'fetch', 'display', 'check', 'status',
  ],
  risk: [
    'critical', 'production', 'urgent', 'security', 'breaking', 'dangerous',
    'irreversible', 'data loss', 'migration', 'deploy',
  ],
  revenue: [
    'client', 'invoice', 'proposal', 'contract', 'deal', 'pipeline',
    'revenue', 'pricing', 'billing', 'payment', 'retainer', 'audit',
  ],
};
