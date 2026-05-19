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
  const excludeDirs = options.excludeDirs ?? ['node_modules', 'dist', '.git', 'coverage', '.claude', 'deepsec-reports'];

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
