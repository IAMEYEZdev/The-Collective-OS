import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { scanDirectory } from './scanner.js';
import { ALL_RULES, STANDARD_RULES, AGENT_THREAT_RULES } from './rules.js';

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

  it('produces valid summary counts', () => {
    const result = scanDirectory(PROJECT_ROOT, ALL_RULES);
    const totalFromSummary = result.summary.critical + result.summary.high
      + result.summary.medium + result.summary.low + result.summary.info;
    expect(totalFromSummary).toBe(result.findings.length);
  });

  it('agent-only scan returns only agent rules', () => {
    const result = scanDirectory(PROJECT_ROOT, AGENT_THREAT_RULES);
    expect(result.rulesApplied).toBe(AGENT_THREAT_RULES.length);
    for (const f of result.findings) {
      expect(f.agentThreat).toBe(true);
    }
  });

  it('standard-only scan returns only standard rules', () => {
    const result = scanDirectory(PROJECT_ROOT, STANDARD_RULES);
    expect(result.rulesApplied).toBe(STANDARD_RULES.length);
    for (const f of result.findings) {
      expect(f.agentThreat).toBe(false);
    }
  });

  it('excludes node_modules and dist by default', () => {
    const result = scanDirectory(PROJECT_ROOT, ALL_RULES);
    const nodeModuleFindings = result.findings.filter(f =>
      f.filePath.includes('node_modules')
    );
    const distFindings = result.findings.filter(f =>
      f.filePath.startsWith('dist/')
    );
    expect(nodeModuleFindings).toHaveLength(0);
    expect(distFindings).toHaveLength(0);
  });
});
