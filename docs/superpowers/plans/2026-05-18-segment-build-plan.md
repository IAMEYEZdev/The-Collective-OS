# Segment Build Plan: 6-Layer Intelligence Architecture

## Goal

Build and activate ClaudeClaw's 6-layer intelligence stack in two segments:
- **Segment A (Layers 1-3)**: GitNexus + DeepSec Fork + Borg ARC — structural awareness, security scanning, and code absorption
- **Segment B (Layers 4-6)**: Hermes/Reflexion + Ax/Self-Discover + Global Workspace — reasoning, self-improvement, and unified coordination

Segment A activates first, runs 3-5 days for integration verification, then Segment B activates on top.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Layer 6: Global Workspace                              │
│  Unified shared context across all agents               │
├─────────────────────────────────────────────────────────┤
│  Layer 5: Ax / Self-Discover                            │
│  Task decomposition + self-discovered reasoning modules │
├─────────────────────────────────────────────────────────┤
│  Layer 4: Hermes / Reflexion                            │
│  Multi-turn reasoning + self-critique + retry loops     │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Borg ARC — Absorption & Integration           │
│  GitHub repo analysis + selective code absorption        │
├─────────────────────────────────────────────────────────┤
│  Layer 2: DeepSec Fork — Security Intelligence          │
│  OWASP SAST + agent threat vectors + graph traversal    │
├─────────────────────────────────────────────────────────┤
│  Layer 1: GitNexus — Structural Awareness    ✅ LIVE    │
│  AST parser → Neo4j graph (78 files, 487 symbols)       │
└─────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript 5.7, ES2022 modules
- **Build**: `tsc` → `dist/`, vitest for tests
- **Graph DB**: Neo4j 5.x (bolt://localhost:7687, neo4j/graphiti2026)
- **AST**: ts-morph 28.x (already in deps)
- **DB**: better-sqlite3 (already in deps)
- **Config**: `.env` + `src/config.ts` pattern
- **Agent SDK**: @anthropic-ai/claude-agent-sdk (CLI engine)

## Existing Infrastructure

Layer 1 (GitNexus) is live with:
- `src/gitnexus/parser.ts` — ts-morph AST walker, extracts File/Symbol nodes + Import/Call/Extends/DefinedIn edges
- `src/gitnexus/ingest.ts` — batched Neo4j MERGE writer, idempotent, clears stale data on re-scan
- `src/gitnexus/query.ts` — 6 query functions: findCallers, findDependencyPath, getSubgraph, analyzeImpact, searchSymbols, getStats
- `src/gitnexus/cli.ts` — 7 CLI commands (scan, stats, callers, path, impact, search, subgraph)
- `src/gitnexus/agent-tool.ts` — JSON-output wrapper for agent consumption
- Daily 5am cron rescan
- `src/security.ts` — PIN lock, kill switch, audit logging (existing security baseline)
- `src/exfiltration-guard.ts` — existing guard rails

---

# SEGMENT A: Layers 1-3

## Layer 1: GitNexus — COMPLETE ✅

Already live. 78 files, 487 symbols, 173 imports, 249 calls in Neo4j. All 7 CLI commands operational. Agent-tool.js exposes JSON API. Daily 5am cron.

No work needed. This is the foundation all other layers build on.

---

## Layer 2: DeepSec Fork — Security Intelligence

### What It Does

Static security analysis purpose-built for agentic systems. Combines 5 capabilities no existing tool offers together:
1. OWASP Top 10 SAST (standard vuln detection)
2. Agent-specific threat detection (OWASP Agentic Top 10 2026: tool misuse, prompt injection, privilege abuse, agent hijacking)
3. Code graph traversal via GitNexus (taint flow through call chains)
4. Local execution (no cloud dependency, no data exfil)
5. Claude/MCP integration (agents can self-scan)

### Task 2.1: Create DeepSec Scanner Core

**File**: `src/deepsec/scanner.ts`

Creates the rule engine that matches regex patterns against source files and returns findings with severity, category, file location, and remediation.

```typescript
/**
 * DeepSec Fork — Static Security Scanner for Agentic Systems
 *
 * Rule-based SAST engine. Runs regex rules against source files,
 * enriched with GitNexus graph data for taint-flow analysis.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category =
  | 'injection'          // SQL, command, prompt injection
  | 'auth'              // broken auth, missing checks
  | 'data-exposure'     // secrets, PII leaks
  | 'agent-hijack'      // agent impersonation, tool misuse
  | 'privilege-abuse'   // escalation, missing RBAC
  | 'supply-chain'      // dependency risks, typosquatting
  | 'config'            // misconfig, debug left on
  | 'crypto';           // weak crypto, hardcoded keys

export interface Rule {
  id: string;                    // e.g., "DS-001"
  name: string;
  category: Category;
  severity: Severity;
  pattern: RegExp;
  description: string;
  remediation: string;
  /** File glob to restrict matching (e.g., "*.ts"). Null = all files */
  fileFilter?: string;
  /** If true, this is an agent-specific threat (OWASP Agentic 2026) */
  agentThreat: boolean;
}

export interface Finding {
  ruleId: string;
  ruleName: string;
  category: Category;
  severity: Severity;
  filePath: string;              // relative to project root
  lineNumber: number;
  lineContent: string;
  match: string;                 // the matched text
  description: string;
  remediation: string;
  agentThreat: boolean;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  rulesApplied: number;
  durationMs: number;
  summary: Record<Severity, number>;
}

// ── Scanner ────────────────────────────────────────────────────────

export function scanFile(
  filePath: string,
  content: string,
  rules: Rule[],
  projectRoot: string
): Finding[] {
  const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');
  const findings: Finding[] = [];

  for (const rule of rules) {
    // Apply file filter if specified
    if (rule.fileFilter) {
      const ext = path.extname(filePath);
      if (!matchesGlob(filePath, rule.fileFilter)) continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(rule.pattern);
      if (match) {
        findings.push({
          ruleId: rule.id,
          ruleName: rule.name,
          category: rule.category,
          severity: rule.severity,
          filePath: relativePath,
          lineNumber: i + 1,
          lineContent: line.trim(),
          match: match[0],
          description: rule.description,
          remediation: rule.remediation,
          agentThreat: rule.agentThreat,
        });
      }
    }
  }

  return findings;
}

export function scanDirectory(
  dirPath: string,
  rules: Rule[],
  options: {
    extensions?: string[];
    excludeDirs?: string[];
  } = {}
): ScanResult {
  const start = Date.now();
  const extensions = options.extensions ?? ['.ts', '.js', '.tsx', '.jsx', '.json', '.env', '.yaml', '.yml'];
  const excludeDirs = options.excludeDirs ?? ['node_modules', 'dist', '.git', 'coverage'];

  const allFindings: Finding[] = [];
  let filesScanned = 0;

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const findings = scanFile(fullPath, content, rules, dirPath);
          allFindings.push(...findings);
          filesScanned++;
        }
      }
    }
  }

  walk(dirPath);

  const summary: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  for (const f of allFindings) {
    summary[f.severity]++;
  }

  return {
    findings: allFindings,
    filesScanned,
    rulesApplied: rules.length,
    durationMs: Date.now() - start,
    summary,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function matchesGlob(filePath: string, glob: string): boolean {
  // Simple glob: *.ts, *.js, etc.
  if (glob.startsWith('*.')) {
    return filePath.endsWith(glob.slice(1));
  }
  return filePath.includes(glob);
}
```

**Test**: `src/deepsec/scanner.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { scanFile, scanDirectory } from './scanner.js';
import type { Rule } from './scanner.js';

const testRule: Rule = {
  id: 'TEST-001',
  name: 'Hardcoded secret',
  category: 'data-exposure',
  severity: 'critical',
  pattern: /(?:password|secret|api_key)\s*=\s*['"][^'"]+['"]/i,
  description: 'Hardcoded secret detected',
  remediation: 'Use environment variables',
  agentThreat: false,
};

describe('scanFile', () => {
  it('finds hardcoded secret', () => {
    const content = 'const password = "hunter2";\nconst x = 1;';
    const findings = scanFile('/test/file.ts', content, [testRule], '/test');
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('TEST-001');
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('returns empty for clean file', () => {
    const content = 'const x = process.env.PASSWORD;';
    const findings = scanFile('/test/file.ts', content, [testRule], '/test');
    expect(findings).toHaveLength(0);
  });
});
```

**Success criteria**: Scanner finds regex matches in files, reports line numbers, handles directory walking with exclusions.

### Task 2.2: Create DeepSec Rule Sets

**File**: `src/deepsec/rules.ts`

Two rule categories: standard OWASP SAST rules and agent-specific threat rules (OWASP Agentic Top 10 2026).

```typescript
/**
 * DeepSec Rule Definitions
 *
 * Two categories:
 * - Standard SAST (OWASP Top 10 web): injection, auth, data exposure, etc.
 * - Agent Threats (OWASP Agentic Top 10 2026): tool misuse, prompt injection,
 *   privilege abuse, agent hijacking, unbounded consumption
 */

import type { Rule } from './scanner.js';

// ── Standard SAST Rules ────────────────────────────────────────────

export const STANDARD_RULES: Rule[] = [
  {
    id: 'DS-001',
    name: 'Hardcoded secret or API key',
    category: 'data-exposure',
    severity: 'critical',
    pattern: /(?:api[_-]?key|secret[_-]?key|password|token|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-\.]{8,}['"]/i,
    description: 'Hardcoded credential found. May be committed to version control.',
    remediation: 'Move to environment variable or secrets manager. Never commit credentials.',
    agentThreat: false,
  },
  {
    id: 'DS-002',
    name: 'SQL injection vector',
    category: 'injection',
    severity: 'high',
    pattern: /(?:query|exec|run|prepare)\s*\(\s*`[^`]*\$\{/,
    description: 'Template literal used in SQL query. Potential SQL injection.',
    remediation: 'Use parameterized queries ($1, $2) instead of template interpolation.',
    agentThreat: false,
  },
  {
    id: 'DS-003',
    name: 'Command injection vector',
    category: 'injection',
    severity: 'critical',
    pattern: /(?:exec|execSync|spawn|execFile)\s*\(\s*(?:`[^`]*\$\{|[^,]+\+)/,
    description: 'User-controlled input in shell command. Command injection risk.',
    remediation: 'Use execFile with argument array. Never interpolate user input into commands.',
    agentThreat: false,
  },
  {
    id: 'DS-004',
    name: 'Eval usage',
    category: 'injection',
    severity: 'high',
    pattern: /\beval\s*\(/,
    description: 'eval() executes arbitrary code. Major injection vector.',
    remediation: 'Remove eval. Use JSON.parse for data, Function constructor only if absolutely required.',
    agentThreat: false,
  },
  {
    id: 'DS-005',
    name: 'Insecure HTTP URL',
    category: 'config',
    severity: 'medium',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    description: 'Non-localhost HTTP URL. Data transmitted in plaintext.',
    remediation: 'Use HTTPS for all external URLs.',
    agentThreat: false,
  },
  {
    id: 'DS-006',
    name: 'Debug/console.log in production code',
    category: 'config',
    severity: 'low',
    pattern: /console\.(log|debug|trace)\s*\(/,
    description: 'Console output may leak sensitive data in production.',
    remediation: 'Use structured logger (pino). Remove console.log from production paths.',
    agentThreat: false,
  },
  {
    id: 'DS-007',
    name: 'Weak random generation',
    category: 'crypto',
    severity: 'medium',
    pattern: /Math\.random\s*\(\)/,
    description: 'Math.random() is not cryptographically secure.',
    remediation: 'Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.',
    agentThreat: false,
  },
  {
    id: 'DS-008',
    name: 'Path traversal risk',
    category: 'injection',
    severity: 'high',
    pattern: /(?:readFile|writeFile|createReadStream|createWriteStream)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/,
    description: 'User input used in file path. Path traversal risk.',
    remediation: 'Validate and sanitize paths. Use path.resolve() + startsWith() check.',
    agentThreat: false,
  },
  {
    id: 'DS-009',
    name: 'Missing error handling on async',
    category: 'config',
    severity: 'low',
    pattern: /\.then\s*\([^)]+\)\s*(?!\.catch)/,
    description: 'Promise .then() without .catch(). Unhandled rejection risk.',
    remediation: 'Add .catch() or use async/await with try/catch.',
    agentThreat: false,
  },
  {
    id: 'DS-010',
    name: 'Disabled TLS verification',
    category: 'crypto',
    severity: 'critical',
    pattern: /rejectUnauthorized\s*:\s*false/,
    description: 'TLS certificate verification disabled. MITM attack vector.',
    remediation: 'Enable TLS verification. Fix underlying certificate issues instead.',
    agentThreat: false,
  },
];

// ── Agent Threat Rules (OWASP Agentic Top 10 2026) ────────────────

export const AGENT_THREAT_RULES: Rule[] = [
  {
    id: 'DA-001',
    name: 'Unbounded tool execution',
    category: 'agent-hijack',
    severity: 'critical',
    pattern: /(?:while\s*\(true\)|for\s*\(\s*;\s*;\s*\)).*(?:exec|spawn|run|tool|invoke)/s,
    description: 'Infinite loop with tool execution. Agent could run unbounded operations.',
    remediation: 'Add MAX_LOOPS constant. Implement loop counter with hard exit.',
    agentThreat: true,
  },
  {
    id: 'DA-002',
    name: 'Missing tool execution timeout',
    category: 'agent-hijack',
    severity: 'high',
    pattern: /(?:exec|execSync|spawn)\s*\([^)]*\)\s*(?!.*timeout)/,
    description: 'Shell execution without timeout. Agent tool call could hang indefinitely.',
    remediation: 'Add timeout option to all exec/spawn calls. Default 120s max.',
    agentThreat: true,
  },
  {
    id: 'DA-003',
    name: 'Prompt injection surface',
    category: 'injection',
    severity: 'critical',
    pattern: /(?:systemPrompt|system_prompt|messages)\s*[+=].*(?:user|input|message|content)/,
    description: 'User-controlled content concatenated into system prompt or message array.',
    remediation: 'Separate system prompts from user content. Never concatenate user input into system messages.',
    agentThreat: true,
  },
  {
    id: 'DA-004',
    name: 'Agent delegation without auth check',
    category: 'privilege-abuse',
    severity: 'high',
    pattern: /(?:delegate|dispatch|createTask|runAgent)\s*\([^)]*\)(?!.*(?:auth|permission|allowed|check))/,
    description: 'Agent delegates task without verifying caller permissions.',
    remediation: 'Verify caller identity and permissions before delegation. Implement RBAC for agent-to-agent calls.',
    agentThreat: true,
  },
  {
    id: 'DA-005',
    name: 'Unrestricted file system access in agent tool',
    category: 'privilege-abuse',
    severity: 'high',
    pattern: /(?:readFile|writeFile|unlink|rmdir)\s*\([^)]*(?:toolInput|toolArgs|params)\[/,
    description: 'Agent tool accesses filesystem using unchecked tool input.',
    remediation: 'Allowlist permitted directories. Validate all paths against project root.',
    agentThreat: true,
  },
  {
    id: 'DA-006',
    name: 'Agent impersonation risk',
    category: 'agent-hijack',
    severity: 'critical',
    pattern: /agentId\s*[:=]\s*(?:req\.|params\.|input\.|args\.)/,
    description: 'Agent ID taken from external input. Agent impersonation possible.',
    remediation: 'Derive agent ID from authenticated session, not from input parameters.',
    agentThreat: true,
  },
  {
    id: 'DA-007',
    name: 'Missing rate limit on agent actions',
    category: 'agent-hijack',
    severity: 'medium',
    pattern: /(?:sendMessage|createPost|sendEmail|apiCall)\s*\([^)]*\)(?!.*(?:rateLimit|throttle|cooldown))/,
    description: 'External action without rate limiting. Agent could spam APIs.',
    remediation: 'Implement per-agent rate limits. Track action counts per time window.',
    agentThreat: true,
  },
  {
    id: 'DA-008',
    name: 'Sensitive data in agent memory/context',
    category: 'data-exposure',
    severity: 'high',
    pattern: /(?:memory|context|store|persist).*(?:password|secret|token|apiKey|credit.?card)/i,
    description: 'Sensitive data may be stored in agent memory or context window.',
    remediation: 'Redact sensitive fields before storing in agent memory. Use reference IDs instead.',
    agentThreat: true,
  },
  {
    id: 'DA-009',
    name: 'Tool output used without sanitization',
    category: 'injection',
    severity: 'high',
    pattern: /tool_?(?:result|output|response)\s*(?:\.\w+\s*)?(?:\+|`\$\{)/,
    description: 'Raw tool output interpolated into next prompt or command. Indirect injection vector.',
    remediation: 'Sanitize and validate all tool outputs before using in subsequent prompts or commands.',
    agentThreat: true,
  },
  {
    id: 'DA-010',
    name: 'No fail-closed behavior',
    category: 'config',
    severity: 'medium',
    pattern: /catch\s*\([^)]*\)\s*\{[^}]*(?:continue|\/\*\s*(?:ok|ignore|swallow))/,
    description: 'Error silently swallowed. Agent proceeds despite failure. Should fail closed.',
    remediation: 'Log errors. For security-critical paths, halt on failure (fail closed).',
    agentThreat: true,
  },
];

/** All rules combined */
export const ALL_RULES: Rule[] = [...STANDARD_RULES, ...AGENT_THREAT_RULES];
```

**Test**: `src/deepsec/rules.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { STANDARD_RULES, AGENT_THREAT_RULES, ALL_RULES } from './rules.js';

describe('rule definitions', () => {
  it('has unique rule IDs', () => {
    const ids = ALL_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('standard rules are not agent threats', () => {
    for (const r of STANDARD_RULES) {
      expect(r.agentThreat).toBe(false);
    }
  });

  it('agent rules are agent threats', () => {
    for (const r of AGENT_THREAT_RULES) {
      expect(r.agentThreat).toBe(true);
    }
  });

  it('all rules have required fields', () => {
    for (const r of ALL_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.name).toBeTruthy();
      expect(r.pattern).toBeInstanceOf(RegExp);
      expect(r.description).toBeTruthy();
      expect(r.remediation).toBeTruthy();
    }
  });
});
```

**Success criteria**: 10 standard SAST rules + 10 agent-threat rules. All IDs unique. All have remediation text.

### Task 2.3: GitNexus Graph Integration (Taint Flow)

**File**: `src/deepsec/graph-enrichment.ts`

Enriches scanner findings with GitNexus graph data. If a finding is in a function, traces callers to understand propagation. Critical for understanding if a vulnerability in a helper is reachable from an entry point.

```typescript
/**
 * DeepSec Graph Enrichment
 *
 * Connects scanner findings to GitNexus graph.
 * Answers: "Is this vulnerability reachable from an entry point?"
 * Answers: "What's the blast radius if this vuln is exploited?"
 */

import type { Driver } from 'neo4j-driver';
import type { Finding } from './scanner.js';
import { findCallers, analyzeImpact } from '../gitnexus/query.js';

export interface EnrichedFinding extends Finding {
  /** Symbols that call the vulnerable code */
  callerChain: string[];
  /** Files in blast radius if this vuln is exploited */
  blastRadius: string[];
  /** Whether this is reachable from an entry point (bot.ts, index.ts, cli.ts) */
  reachableFromEntry: boolean;
  /** Enrichment confidence: 'high' if resolved through graph, 'low' if symbol not found */
  graphConfidence: 'high' | 'low' | 'none';
}

const ENTRY_POINTS = ['src/index.ts', 'src/bot.ts', 'src/agent.ts'];

export async function enrichFindings(
  findings: Finding[],
  driver: Driver
): Promise<EnrichedFinding[]> {
  const enriched: EnrichedFinding[] = [];

  for (const finding of findings) {
    try {
      // Try to find the enclosing symbol via line number
      const impact = await analyzeImpact(driver, finding.filePath);

      const callerChain = impact.callers.map(c => `${c.callerName} (${c.callerFile})`);
      const blastRadius = [
        ...impact.directDependents,
        ...impact.callers.map(c => c.callerFile),
      ];

      const reachableFromEntry = blastRadius.some(f =>
        ENTRY_POINTS.some(ep => f.includes(ep))
      ) || ENTRY_POINTS.some(ep => finding.filePath.includes(ep));

      enriched.push({
        ...finding,
        callerChain,
        blastRadius: [...new Set(blastRadius)],
        reachableFromEntry,
        graphConfidence: callerChain.length > 0 ? 'high' : 'low',
      });
    } catch {
      // Graph unavailable or query failed — return unenriched
      enriched.push({
        ...finding,
        callerChain: [],
        blastRadius: [],
        reachableFromEntry: false,
        graphConfidence: 'none',
      });
    }
  }

  return enriched;
}
```

**Success criteria**: Findings enriched with caller chains and blast radius from Neo4j. Entry point reachability detected. Graceful fallback when graph unavailable.

### Task 2.4: DeepSec CLI + Agent Tool

**File**: `src/deepsec/cli.ts`

```typescript
#!/usr/bin/env node
/**
 * DeepSec CLI — Security scanning for ClaudeClaw
 *
 * Usage:
 *   node dist/deepsec/cli.js scan [--dir path] [--json]     # full scan
 *   node dist/deepsec/cli.js scan --agent-only               # agent threats only
 *   node dist/deepsec/cli.js report [--dir path]             # human-readable report
 *   node dist/deepsec/cli.js rules                            # list all rules
 */

import path from 'node:path';
import { scanDirectory } from './scanner.js';
import { ALL_RULES, AGENT_THREAT_RULES, STANDARD_RULES } from './rules.js';
import { enrichFindings } from './graph-enrichment.js';
import { createDriver } from '../gitnexus/ingest.js';

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT
  ?? path.resolve(import.meta.dirname, '..', '..');

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case 'scan': {
      const dirIndex = args.indexOf('--dir');
      const dir = dirIndex !== -1 ? args[dirIndex + 1] : PROJECT_ROOT;
      const jsonOutput = args.includes('--json');
      const agentOnly = args.includes('--agent-only');

      const rules = agentOnly ? AGENT_THREAT_RULES : ALL_RULES;
      const result = scanDirectory(dir, rules);

      // Enrich with graph data if Neo4j is available
      let enrichedFindings = result.findings;
      try {
        const driver = createDriver();
        enrichedFindings = await enrichFindings(result.findings, driver) as any;
        await driver.close();
      } catch {
        // Neo4j unavailable — proceed without enrichment
      }

      if (jsonOutput) {
        console.log(JSON.stringify({ ...result, findings: enrichedFindings }, null, 2));
      } else {
        console.log(`DeepSec Scan Complete`);
        console.log(`  Files scanned: ${result.filesScanned}`);
        console.log(`  Rules applied: ${result.rulesApplied}`);
        console.log(`  Duration: ${result.durationMs}ms`);
        console.log(`  Findings: ${result.findings.length}`);
        console.log(`    Critical: ${result.summary.critical}`);
        console.log(`    High: ${result.summary.high}`);
        console.log(`    Medium: ${result.summary.medium}`);
        console.log(`    Low: ${result.summary.low}`);
        console.log(`    Info: ${result.summary.info}`);

        if (result.findings.length > 0) {
          console.log('\nFindings:\n');
          for (const f of enrichedFindings) {
            const marker = f.agentThreat ? ' [AGENT]' : '';
            console.log(`  [${f.severity.toUpperCase()}]${marker} ${f.ruleId}: ${f.ruleName}`);
            console.log(`    ${f.filePath}:${f.lineNumber}`);
            console.log(`    ${f.lineContent}`);
            console.log(`    Fix: ${f.remediation}`);
            console.log();
          }
        }
      }
      break;
    }

    case 'rules': {
      console.log('DeepSec Rules:\n');
      console.log('Standard SAST:');
      for (const r of STANDARD_RULES) {
        console.log(`  ${r.id} [${r.severity}] ${r.name}`);
      }
      console.log('\nAgent Threats (OWASP Agentic 2026):');
      for (const r of AGENT_THREAT_RULES) {
        console.log(`  ${r.id} [${r.severity}] ${r.name}`);
      }
      break;
    }

    default:
      console.log('Usage: deepsec scan [--dir path] [--json] [--agent-only]');
      console.log('       deepsec rules');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('DeepSec error:', err.message ?? err);
  process.exit(1);
});
```

**File**: `src/deepsec/agent-tool.ts`

```typescript
#!/usr/bin/env node
/**
 * DeepSec Agent Tool — JSON output for agent consumption
 *
 * node dist/deepsec/agent-tool.js scan
 * node dist/deepsec/agent-tool.js scan --agent-only
 */

import path from 'node:path';
import { scanDirectory } from './scanner.js';
import { ALL_RULES, AGENT_THREAT_RULES } from './rules.js';
import { enrichFindings } from './graph-enrichment.js';
import { createDriver } from '../gitnexus/ingest.js';

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT
  ?? path.resolve(import.meta.dirname, '..', '..');

const args = process.argv.slice(2);

async function run(): Promise<void> {
  const agentOnly = args.includes('--agent-only');
  const rules = agentOnly ? AGENT_THREAT_RULES : ALL_RULES;
  const result = scanDirectory(PROJECT_ROOT, rules);

  let enrichedFindings = result.findings;
  try {
    const driver = createDriver();
    enrichedFindings = await enrichFindings(result.findings, driver) as any;
    await driver.close();
  } catch {
    // proceed without enrichment
  }

  // Fail-closed: if critical findings exist, exit code 1
  const exitCode = result.summary.critical > 0 ? 1 : 0;

  console.log(JSON.stringify({
    ok: exitCode === 0,
    scan: {
      filesScanned: result.filesScanned,
      rulesApplied: result.rulesApplied,
      durationMs: result.durationMs,
      summary: result.summary,
    },
    findings: enrichedFindings,
    failClosed: exitCode === 1,
  }, null, 2));

  process.exit(exitCode);
}

run();
```

**Success criteria**: CLI scan produces human-readable output. Agent tool produces JSON. `--agent-only` flag filters to agent threats. Fail-closed: exit code 1 on critical findings.

### Task 2.5: DeepSec Integration Tests

**File**: `src/deepsec/integration.test.ts`

Run DeepSec against the actual ClaudeClaw codebase and verify it finds expected patterns (console.log usage, known exec calls, etc.) without false-flagging safe code.

```typescript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { scanDirectory } from './scanner.js';
import { ALL_RULES } from './rules.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('DeepSec integration', () => {
  it('scans ClaudeClaw codebase without crashing', () => {
    const result = scanDirectory(PROJECT_ROOT, ALL_RULES);
    expect(result.filesScanned).toBeGreaterThan(50);
    expect(result.rulesApplied).toBe(ALL_RULES.length);
    expect(result.durationMs).toBeLessThan(30000); // under 30s
  });

  it('finds known console.log usage', () => {
    const result = scanDirectory(PROJECT_ROOT, ALL_RULES);
    const consoleLogs = result.findings.filter(f => f.ruleId === 'DS-006');
    expect(consoleLogs.length).toBeGreaterThan(0);
  });

  it('does not flag Neo4j bolt URL as insecure HTTP', () => {
    const result = scanDirectory(PROJECT_ROOT, ALL_RULES);
    const httpFindings = result.findings.filter(f =>
      f.ruleId === 'DS-005' && f.lineContent.includes('bolt://')
    );
    expect(httpFindings).toHaveLength(0);
  });
});
```

**Success criteria**: Full codebase scan completes under 30s, finds expected patterns, no crashes on edge cases.

### Layer 2 DeepSec Scan Protocol

After Layer 2 is built:
1. Run `node dist/deepsec/cli.js scan` on full codebase
2. Review all critical + high findings
3. Fix genuine vulnerabilities before proceeding to Layer 3
4. Optional: $20 Semgrep cloud scan for second opinion (recommended but not blocking)
5. Save scan results to `docs/deepsec-reports/` for audit trail

**Estimated build time**: 3-4 days (Tasks 2.1-2.5)

---

## Layer 3: Borg ARC — Absorption & Integration

### What It Does

Borg ARC analyzes GitHub repositories, evaluates them for absorption into ClaudeClaw, and performs selective code integration. Every absorption requires Melanie's recommendation + Jason's approval.

### Task 3.1: Borg ARC Repository Analyzer

**File**: `src/borg-arc/analyzer.ts`

```typescript
/**
 * Borg ARC — Repository Analysis & Selective Absorption
 *
 * Evaluates GitHub repos for integration into ClaudeClaw.
 * Produces structured analysis: compatibility, quality, risk, absorption plan.
 * Every absorption requires human approval (Melanie recommends, Jason confirms).
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RepoAnalysis {
  repoUrl: string;
  repoName: string;
  analyzedAt: string;

  // Compatibility assessment
  compatibility: {
    language: string;
    runtime: string;
    dependencies: string[];
    conflictingDeps: string[];        // deps that clash with ClaudeClaw
    licenseCompatible: boolean;
    license: string;
  };

  // Quality signals
  quality: {
    hasTests: boolean;
    hasTypes: boolean;                 // TypeScript or JSDoc
    lastCommitDate: string;
    stars: number;
    openIssues: number;
    maintainerActive: boolean;         // commit in last 90 days
  };

  // What to absorb
  absorptionPlan: {
    targetFiles: string[];             // specific files to extract
    estimatedLines: number;
    integrationPoint: string;          // which ClaudeClaw module this connects to
    adaptationNeeded: string[];        // what needs changing (imports, config, etc.)
  };

  // Risk
  risk: {
    securityScanRequired: boolean;     // always true before absorption
    breakingChanges: string[];
    reversibility: 'easy' | 'medium' | 'hard';
  };

  // Approval chain
  approval: {
    melanieRecommendation: 'absorb' | 'skip' | 'watch';
    melanieReason: string;
    jasonApproved: boolean | null;     // null = pending
  };
}

export interface AbsorptionRecord {
  repoUrl: string;
  absorbedAt: string;
  filesAbsorbed: string[];
  deepsecScanPassed: boolean;
  approvedBy: string;
}

/**
 * Analyze a local clone of a repository for absorption potential.
 */
export function analyzeLocalRepo(
  repoPath: string,
  repoUrl: string
): Omit<RepoAnalysis, 'approval'> {
  const pkgPath = path.join(repoPath, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  const pkg = hasPkg ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) : {};

  const tsconfigExists = fs.existsSync(path.join(repoPath, 'tsconfig.json'));
  const hasTests = fs.existsSync(path.join(repoPath, '__tests__'))
    || fs.existsSync(path.join(repoPath, 'test'))
    || (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1');

  const licensePath = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
    .map(f => path.join(repoPath, f))
    .find(f => fs.existsSync(f));
  const licenseContent = licensePath ? fs.readFileSync(licensePath, 'utf-8') : '';
  const license = detectLicense(licenseContent);

  const deps = Object.keys(pkg.dependencies ?? {});
  const claudeclawPkg = JSON.parse(
    fs.readFileSync(path.join(process.env.CLAUDECLAW_PROJECT_ROOT ?? '.', 'package.json'), 'utf-8')
  );
  const ourDeps = Object.keys(claudeclawPkg.dependencies ?? {});
  const conflicting = deps.filter(d => {
    if (!ourDeps.includes(d)) return false;
    // Same dep, different major version = conflict
    return false; // simplified — full version comparison in implementation
  });

  return {
    repoUrl,
    repoName: path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    compatibility: {
      language: tsconfigExists ? 'TypeScript' : 'JavaScript',
      runtime: 'Node.js',
      dependencies: deps,
      conflictingDeps: conflicting,
      licenseCompatible: ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause'].includes(license),
      license,
    },
    quality: {
      hasTests: !!hasTests,
      hasTypes: tsconfigExists,
      lastCommitDate: '', // filled by git log
      stars: 0,           // filled by GitHub API
      openIssues: 0,      // filled by GitHub API
      maintainerActive: false, // filled by git log
    },
    absorptionPlan: {
      targetFiles: [],
      estimatedLines: 0,
      integrationPoint: '',
      adaptationNeeded: [],
    },
    risk: {
      securityScanRequired: true, // always
      breakingChanges: [],
      reversibility: 'easy',
    },
  };
}

function detectLicense(content: string): string {
  if (content.includes('MIT License')) return 'MIT';
  if (content.includes('Apache License')) return 'Apache-2.0';
  if (content.includes('ISC License')) return 'ISC';
  if (content.includes('BSD 2-Clause')) return 'BSD-2-Clause';
  if (content.includes('BSD 3-Clause')) return 'BSD-3-Clause';
  return 'UNKNOWN';
}
```

**Success criteria**: Analyzes cloned repo, detects language/deps/license/tests, identifies dep conflicts with ClaudeClaw, flags security scan requirement.

### Task 3.2: Borg ARC Absorption Engine

**File**: `src/borg-arc/absorb.ts`

Copies target files from analyzed repo into ClaudeClaw, rewrites imports, runs DeepSec scan on absorbed code, records absorption in SQLite.

```typescript
/**
 * Borg ARC Absorption Engine
 *
 * Copies selected files from analyzed repo into ClaudeClaw.
 * Rewrites imports, runs DeepSec scan, records in audit trail.
 * NEVER executes without human approval.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanFile } from '../deepsec/scanner.js';
import { ALL_RULES } from '../deepsec/rules.js';
import type { AbsorptionRecord, RepoAnalysis } from './analyzer.js';

export interface AbsorbOptions {
  analysis: RepoAnalysis;
  sourceDir: string;           // cloned repo path
  targetSubdir: string;        // e.g., 'src/absorbed/repo-name'
  approvedBy: string;          // must be "jason"
}

export interface AbsorbResult {
  success: boolean;
  filesAbsorbed: string[];
  deepsecFindings: number;
  criticalFindings: number;
  record: AbsorptionRecord;
}

export function absorbRepo(options: AbsorbOptions): AbsorbResult {
  const { analysis, sourceDir, targetSubdir, approvedBy } = options;
  const projectRoot = process.env.CLAUDECLAW_PROJECT_ROOT ?? '.';
  const targetDir = path.join(projectRoot, targetSubdir);

  // Safety: must have approval
  if (!analysis.approval.jasonApproved) {
    throw new Error('Cannot absorb without Jason approval');
  }
  if (approvedBy.toLowerCase() !== 'jason') {
    throw new Error('Only Jason can approve absorptions');
  }

  // Create target directory
  fs.mkdirSync(targetDir, { recursive: true });

  const filesAbsorbed: string[] = [];
  let totalFindings = 0;
  let criticalFindings = 0;

  for (const file of analysis.absorptionPlan.targetFiles) {
    const sourcePath = path.join(sourceDir, file);
    if (!fs.existsSync(sourcePath)) continue;

    const content = fs.readFileSync(sourcePath, 'utf-8');

    // DeepSec scan BEFORE absorption (fail-closed)
    const findings = scanFile(sourcePath, content, ALL_RULES, sourceDir);
    const criticals = findings.filter(f => f.severity === 'critical');
    totalFindings += findings.length;
    criticalFindings += criticals.length;

    if (criticals.length > 0) {
      console.error(`BLOCKED: ${file} has ${criticals.length} critical findings. Skipping.`);
      continue;
    }

    // Copy file
    const targetPath = path.join(targetDir, path.basename(file));
    fs.writeFileSync(targetPath, content, 'utf-8');
    filesAbsorbed.push(targetPath);
  }

  const record: AbsorptionRecord = {
    repoUrl: analysis.repoUrl,
    absorbedAt: new Date().toISOString(),
    filesAbsorbed,
    deepsecScanPassed: criticalFindings === 0,
    approvedBy,
  };

  return {
    success: criticalFindings === 0,
    filesAbsorbed,
    deepsecFindings: totalFindings,
    criticalFindings,
    record,
  };
}
```

**Success criteria**: Absorption blocked if DeepSec finds critical issues. Requires Jason approval. Files copied with audit trail. Fail-closed on critical findings.

### Task 3.3: Borg ARC CLI + Agent Tool

**File**: `src/borg-arc/cli.ts`

CLI with commands: `analyze <repo-path>`, `absorb <repo-path> --approved-by jason`, `history` (list past absorptions).

Agent tool variant outputs JSON.

**Success criteria**: CLI analyzes repos, absorption requires explicit approval flag, history shows audit trail.

### Segment A Integration Verification

After all 3 layers built:
1. Run `node dist/gitnexus/cli.js scan` — verify graph is current
2. Run `node dist/deepsec/cli.js scan` — full security scan
3. Fix all critical findings
4. Run `node dist/deepsec/cli.js scan --agent-only` — verify agent threats are addressed
5. Mandatory full DeepSec scan before going live
6. Live with Segment A for 3-5 days
7. Monitor: scan results, Neo4j query performance, absorption logs
8. Weekly DeepSec scan cycle begins

---

# SEGMENT B: Layers 4-6

**Segment B activates after Segment A runs stable for 3-5 days.**

## Layer 4: Hermes/Reflexion — Multi-Turn Reasoning

### What It Does

Adds structured reasoning patterns to agent responses. Hermes provides multi-turn chain-of-thought. Reflexion adds self-critique loops: agent generates answer, critiques it, refines.

### Task 4.1: Reflexion Engine

**File**: `src/reflexion/engine.ts`

Core loop: generate initial response, self-critique via structured prompt, refine if critique identifies issues, return best version. Max 3 refinement passes.

Key interface:
```typescript
export interface ReflexionResult {
  finalAnswer: string;
  iterations: number;
  critiques: string[];
  improved: boolean;
}
```

**Success criteria**: Agent can self-critique and refine responses. Max 3 iterations. Returns both final answer and critique trail.

### Task 4.2: Reflexion Integration with Agent Loop

**File**: Modify `src/agent.ts`

Add optional reflexion mode triggered by task complexity signals. Simple questions skip reflexion. Complex tasks (multi-file code changes, architectural decisions, research synthesis) route through reflexion engine.

**Success criteria**: Reflexion activates on complex tasks, skipped on simple ones. No latency impact on quick queries.

## Layer 5: Ax/Self-Discover — Task Decomposition

### What It Does

Implements Self-Discover (Zhou et al. 2024): given a complex task, the agent first discovers which reasoning modules apply (critical thinking, creative thinking, systems thinking, etc.), then composes them into a task-specific reasoning structure, then executes.

### Task 5.1: Self-Discover Module Library

**File**: `src/self-discover/modules.ts`

Library of reasoning modules the agent can select from. Each module is a structured prompt template.

### Task 5.2: Self-Discover Composer

**File**: `src/self-discover/composer.ts`

Takes a task description, selects relevant modules, composes them into an execution plan. Three phases: SELECT (pick modules), ADAPT (tailor to task), IMPLEMENT (execute with structure).

**Success criteria**: Complex tasks decomposed into structured reasoning steps. Module selection is task-appropriate.

## Layer 6: Global Workspace — Unified Context

### What It Does

Shared context layer across all ClaudeClaw agents (Melanie, James, Annika, Sean, Melissa, Jackson). Inspired by Global Workspace Theory: important information gets "broadcast" to all agents. Currently each agent has siloed context.

### Task 6.1: Global Workspace Store

**File**: `src/global-workspace/store.ts`

SQLite-backed shared context store. Agents can publish facts, decisions, and signals. Other agents query the workspace for relevant context before acting.

### Task 6.2: Workspace Broadcasting

**File**: `src/global-workspace/broadcast.ts`

When an agent publishes high-importance information (client decision, technical blocker, schedule change), it's broadcast as context available to all other agents on their next turn.

### Task 6.3: Workspace Integration

Modify `src/bot.ts` and `src/agent.ts` to inject relevant workspace context into each agent turn.

**Success criteria**: Agents share context without direct messaging. Important decisions visible to all agents. No single-agent bottleneck.

### Segment B Integration Verification

1. Full DeepSec scan before activation
2. Test reflexion on sample complex tasks — verify improvement
3. Test self-discover on decomposition scenarios
4. Test global workspace: publish from one agent, verify visibility from another
5. Monitor: response quality, latency impact, token cost increase
6. Weekly DeepSec scan continues

---

# Timeline

| Phase | Layer | Effort | Dependencies |
|-------|-------|--------|-------------|
| Week 1, Days 1-2 | Layer 2: DeepSec scanner + rules (Tasks 2.1-2.2) | 2 days | Layer 1 (done) |
| Week 1, Days 3-4 | Layer 2: Graph enrichment + CLI (Tasks 2.3-2.5) | 2 days | Tasks 2.1-2.2 |
| Week 2, Days 1-2 | Layer 3: Borg ARC analyzer + absorb (Tasks 3.1-3.2) | 2 days | Layer 2 |
| Week 2, Day 3 | Layer 3: CLI + integration tests (Task 3.3) | 1 day | Tasks 3.1-3.2 |
| Week 2, Days 4-5 | **Segment A integration + DeepSec full scan** | 2 days | All Layer 2+3 |
| Week 3 | **Segment A live verification (3-5 days)** | monitoring | Segment A |
| Week 4, Days 1-2 | Layer 4: Reflexion engine + integration (Tasks 4.1-4.2) | 2 days | Segment A stable |
| Week 4, Days 3-4 | Layer 5: Self-Discover modules + composer (Tasks 5.1-5.2) | 2 days | Layer 4 |
| Week 5, Days 1-3 | Layer 6: Global Workspace (Tasks 6.1-6.3) | 3 days | Layers 4+5 |
| Week 5, Days 4-5 | **Segment B integration + full scan + activation** | 2 days | All layers |

**Total: ~5 weeks, with Segment A live by end of Week 2.**

# Scan Protocol Summary

| Checkpoint | Scan Type | Cost | Blocking? |
|-----------|-----------|------|-----------|
| After Layer 2 built | DeepSec self-scan | Free | Yes (fix criticals) |
| Before Segment A go-live | Full DeepSec scan | Free | Yes (mandatory) |
| Between Segment A and B | Optional Semgrep cloud | ~$20 | No (recommended) |
| Before Segment B go-live | Full DeepSec scan | Free | Yes (mandatory) |
| Post-launch | Weekly DeepSec cycle | Free | No (fix criticals within 48h) |

# Files Created by This Plan

| File | Layer | Purpose |
|------|-------|---------|
| `src/deepsec/scanner.ts` | 2 | Rule engine + directory walker |
| `src/deepsec/scanner.test.ts` | 2 | Scanner unit tests |
| `src/deepsec/rules.ts` | 2 | 20 rules (10 SAST + 10 agent) |
| `src/deepsec/rules.test.ts` | 2 | Rule definition tests |
| `src/deepsec/graph-enrichment.ts` | 2 | GitNexus taint flow integration |
| `src/deepsec/cli.ts` | 2 | Human-readable CLI |
| `src/deepsec/agent-tool.ts` | 2 | JSON agent interface |
| `src/deepsec/integration.test.ts` | 2 | Full-codebase scan tests |
| `src/borg-arc/analyzer.ts` | 3 | Repo analysis engine |
| `src/borg-arc/absorb.ts` | 3 | Selective absorption + DeepSec gate |
| `src/borg-arc/cli.ts` | 3 | Borg ARC CLI |
| `src/reflexion/engine.ts` | 4 | Self-critique + refinement loop |
| `src/self-discover/modules.ts` | 5 | Reasoning module library |
| `src/self-discover/composer.ts` | 5 | Module selection + composition |
| `src/global-workspace/store.ts` | 6 | Shared context SQLite store |
| `src/global-workspace/broadcast.ts` | 6 | Cross-agent broadcasting |
