/**
 * Complexity Signal Extraction — ClaudeClaw Collective
 *
 * Extracts complexity signals from task prompts via regex-based analysis.
 * No model calls required — pure lexical/structural parsing.
 */

import type {
  LexicalSignals,
  StructuralSignals,
  ContextSignals,
  ComplexitySignals,
  RoutingContext,
} from './types.js';
import { COMPLEXITY_KEYWORDS } from './types.js';

/** Extract lexical signals from task prompt */
export function extractLexicalSignals(prompt: string): LexicalSignals {
  const lower = prompt.toLowerCase();
  const words = prompt.split(/\s+/).filter(w => w.length > 0);

  return {
    wordCount: words.length,
    filePathCount: countFilePaths(prompt),
    codeBlockCount: countCodeBlocks(prompt),
    hasArchitectureKeywords: hasKeywords(lower, COMPLEXITY_KEYWORDS.architecture),
    hasDebuggingKeywords: hasKeywords(lower, COMPLEXITY_KEYWORDS.debugging),
    hasSimpleKeywords: hasKeywords(lower, COMPLEXITY_KEYWORDS.simple),
    hasRiskKeywords: hasKeywords(lower, COMPLEXITY_KEYWORDS.risk),
    hasRevenueKeywords: hasKeywords(lower, COMPLEXITY_KEYWORDS.revenue),
    questionDepth: detectQuestionDepth(lower),
    hasImplicitRequirements: detectImplicitRequirements(lower),
  };
}

/** Extract structural signals from task prompt */
export function extractStructuralSignals(prompt: string): StructuralSignals {
  const lower = prompt.toLowerCase();

  return {
    estimatedSubtasks: estimateSubtasks(prompt),
    crossFileDependencies: detectCrossFileDependencies(prompt),
    hasTestRequirements: detectTestRequirements(lower),
    domainSpecificity: detectDomain(lower),
    requiresExternalKnowledge: detectExternalKnowledge(lower),
    reversibility: assessReversibility(lower),
    impactScope: assessImpactScope(prompt),
  };
}

/** Extract context signals from routing context */
export function extractContextSignals(context: RoutingContext): ContextSignals {
  return {
    previousFailures: context.previousFailures ?? 0,
    priority: context.priority ?? 5,
    agentChainDepth: context.agentChainDepth ?? 0,
  };
}

/** Extract all complexity signals */
export function extractAllSignals(
  prompt: string,
  context: RoutingContext
): ComplexitySignals {
  return {
    lexical: extractLexicalSignals(prompt),
    structural: extractStructuralSignals(prompt),
    context: extractContextSignals(context),
  };
}

// ---- Helpers ----

function countFilePaths(prompt: string): number {
  const patterns = [
    /(?:^|\s)[.\/~]?(?:[\w-]+\/)+[\w.-]+\.\w+/gm,
    /`[^`]+\.\w+`/g,
    /['"][^'"]+\.\w+['"]/g,
  ];
  let count = 0;
  for (const p of patterns) {
    const m = prompt.match(p);
    if (m) count += m.length;
  }
  return Math.min(count, 20);
}

function countCodeBlocks(prompt: string): number {
  const fenced = (prompt.match(/```[\s\S]*?```/g) || []).length;
  const indented = (prompt.match(/(?:^|\n)(?:\s{4}|\t)[^\n]+(?:\n(?:\s{4}|\t)[^\n]+)*/g) || []).length;
  return fenced + Math.floor(indented / 2);
}

function hasKeywords(prompt: string, keywords: string[]): boolean {
  return keywords.some(kw => {
    // Word-boundary match to avoid "research" matching "search" etc.
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(prompt);
  });
}

function detectQuestionDepth(prompt: string): 'why' | 'how' | 'what' | 'where' | 'none' {
  if (/\bwhy\b.*\?|\bwhy\s+(is|are|does|do|did|would|should|can)/i.test(prompt)) return 'why';
  if (/\bhow\b.*\?|\bhow\s+(do|does|can|should|would|to)/i.test(prompt)) return 'how';
  if (/\bwhat\b.*\?|\bwhat\s+(is|are|does|do)/i.test(prompt)) return 'what';
  if (/\bwhere\b.*\?|\bwhere\s+(is|are|does|do|can)/i.test(prompt)) return 'where';
  return 'none';
}

function detectImplicitRequirements(prompt: string): boolean {
  const vague = [
    /\bmake it better\b/,
    /\bimprove\b(?!.*(?:by|to|so that))/,
    /\bfix\b(?!.*(?:the|this|that|in|at))/,
    /\boptimize\b(?!.*(?:by|for|to))/,
    /\bclean up\b/,
  ];
  return vague.some(p => p.test(prompt));
}

function estimateSubtasks(prompt: string): number {
  let count = 1;
  count += (prompt.match(/^[\s]*[-*]\s/gm) || []).length;
  count += (prompt.match(/^[\s]*\d+[.)]\s/gm) || []).length;
  count += Math.floor((prompt.match(/\band\b/gi) || []).length / 2);
  count += (prompt.match(/\bthen\b/gi) || []).length;
  return Math.min(count, 10);
}

function detectCrossFileDependencies(prompt: string): boolean {
  if (countFilePaths(prompt) >= 2) return true;
  const indicators = [
    /multiple files/i, /across.*files/i, /several.*files/i,
    /throughout.*codebase/i, /entire.*project/i,
  ];
  return indicators.some(p => p.test(prompt));
}

function detectTestRequirements(prompt: string): boolean {
  const indicators = [
    /\btests?\b/i, /\bspec\b/i, /make sure.*work/i,
    /verify/i, /ensure.*pass/i, /\bTDD\b/, /unit test/i,
  ];
  return indicators.some(p => p.test(prompt));
}

function detectDomain(
  prompt: string
): 'generic' | 'content' | 'research' | 'sales' | 'ops' | 'security' {
  const domains: Record<string, RegExp[]> = {
    content: [
      /\b(linkedin|post|article|content|video|thumbnail|hook|carousel|newsletter)\b/i,
      /\b(brand|voice|copy|headline|caption|engagement)\b/i,
    ],
    research: [
      /\b(research|prospect|intel|competitor|market|trend|analysis|scan)\b/i,
      /\b(company|industry|funding|news|signal)\b/i,
    ],
    sales: [
      /\b(client|deal|pipeline|proposal|invoice|crm|lead|prospect|outreach)\b/i,
      /\b(revenue|billing|contract|pricing|retainer|discovery call)\b/i,
    ],
    ops: [
      /\b(schedule|calendar|deadline|meeting|standup|sprint|backlog)\b/i,
      /\b(deploy|ci|cd|docker|server|monitoring|infra)\b/i,
    ],
    security: [
      /\b(security|auth|oauth|jwt|encryption|vulnerability|xss|csrf)\b/i,
      /\b(password|credential|secret|token|permission)\b/i,
    ],
  };

  for (const [domain, patterns] of Object.entries(domains)) {
    if (patterns.some(p => p.test(prompt))) {
      return domain as 'content' | 'research' | 'sales' | 'ops' | 'security';
    }
  }
  return 'generic';
}

function detectExternalKnowledge(prompt: string): boolean {
  const indicators = [
    /\bdocs?\b/i, /\bdocumentation\b/i, /\blibrary\b/i,
    /\bframework\b/i, /\bhow does.*work\b/i, /\bbest practice/i,
  ];
  return indicators.some(p => p.test(prompt));
}

function assessReversibility(prompt: string): 'easy' | 'moderate' | 'difficult' {
  const difficult = [
    /\bmigrat/i, /\bproduction\b/i, /\bdata.*loss/i,
    /\bdelete.*all/i, /\birreversible/i, /\bpermanent/i,
  ];
  const moderate = [
    /\brefactor/i, /\brestructure/i, /\brename.*across/i,
    /\bchange.*schema/i,
  ];
  if (difficult.some(p => p.test(prompt))) return 'difficult';
  if (moderate.some(p => p.test(prompt))) return 'moderate';
  return 'easy';
}

function assessImpactScope(prompt: string): 'local' | 'module' | 'system-wide' {
  const systemWide = [
    /\bentire\b/i, /\ball\s+(?:files|components|modules|agents)/i,
    /\bwhole\s+(?:project|codebase|system)/i, /\bsystem.?wide/i,
    /\bglobal/i, /\beverywhere/i, /\bthroughout/i,
  ];
  const module = [
    /\bmodule/i, /\bservice/i, /\bfeature/i, /\bpipeline/i,
  ];

  if (systemWide.some(p => p.test(prompt))) return 'system-wide';
  if (countFilePaths(prompt) >= 3) return 'module';
  if (module.some(p => p.test(prompt))) return 'module';
  return 'local';
}
