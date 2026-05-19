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
import type { EnrichedFinding } from './graph-enrichment.js';
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
      let enrichedFindings: (EnrichedFinding | typeof result.findings[number])[] = result.findings;
      try {
        const driver = createDriver();
        enrichedFindings = await enrichFindings(result.findings, driver);
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
            const reachable = 'reachableFromEntry' in f && f.reachableFromEntry ? ' [REACHABLE]' : '';
            console.log(`  [${f.severity.toUpperCase()}]${marker}${reachable} ${f.ruleId}: ${f.ruleName}`);
            console.log(`    ${f.filePath}:${f.lineNumber}`);
            console.log(`    ${f.lineContent}`);
            console.log(`    Fix: ${f.remediation}`);
            if ('callerChain' in f && f.callerChain.length > 0) {
              console.log(`    Callers: ${f.callerChain.slice(0, 5).join(' -> ')}`);
            }
            if ('blastRadius' in f && f.blastRadius.length > 0) {
              console.log(`    Blast radius: ${f.blastRadius.length} files`);
            }
            console.log();
          }
        }
      }
      break;
    }

    case 'rules': {
      console.log('DeepSec Rules:\n');
      console.log('Standard SAST (OWASP Top 10):');
      for (const r of STANDARD_RULES) {
        console.log(`  ${r.id} [${r.severity}] ${r.name}`);
      }
      console.log('\nAgent Threats (OWASP Agentic 2026) — PRIORITY 1:');
      for (const r of AGENT_THREAT_RULES) {
        console.log(`  ${r.id} [${r.severity}] ${r.name}`);
      }
      console.log(`\nTotal: ${ALL_RULES.length} rules (${STANDARD_RULES.length} standard + ${AGENT_THREAT_RULES.length} agent)`);
      break;
    }

    default:
      console.log('DeepSec — Security Scanner for Agentic Systems\n');
      console.log('Usage:');
      console.log('  deepsec scan [--dir path] [--json] [--agent-only]   Scan for vulnerabilities');
      console.log('  deepsec rules                                        List all rules');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('DeepSec error:', err.message ?? err);
  process.exit(1);
});
