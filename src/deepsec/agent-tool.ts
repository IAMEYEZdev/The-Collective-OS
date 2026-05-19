#!/usr/bin/env node
/**
 * DeepSec Agent Tool — JSON output for agent consumption
 *
 * node dist/deepsec/agent-tool.js scan
 * node dist/deepsec/agent-tool.js scan --agent-only
 *
 * Exit code 1 on critical findings (fail-closed).
 */

import path from 'node:path';
import { scanDirectory } from './scanner.js';
import { ALL_RULES, AGENT_THREAT_RULES } from './rules.js';
import { enrichFindings } from './graph-enrichment.js';
import type { EnrichedFinding } from './graph-enrichment.js';
import { createDriver } from '../gitnexus/ingest.js';

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT
  ?? path.resolve(import.meta.dirname, '..', '..');

const args = process.argv.slice(2);

async function run(): Promise<void> {
  const agentOnly = args.includes('--agent-only');
  const rules = agentOnly ? AGENT_THREAT_RULES : ALL_RULES;
  const result = scanDirectory(PROJECT_ROOT, rules);

  let enrichedFindings: (EnrichedFinding | typeof result.findings[number])[] = result.findings;
  try {
    const driver = createDriver();
    enrichedFindings = await enrichFindings(result.findings, driver);
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
    agentOnlyMode: agentOnly,
    failClosed: exitCode === 1,
  }, null, 2));

  process.exit(exitCode);
}

run();
