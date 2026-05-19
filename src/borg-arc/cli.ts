#!/usr/bin/env node
/**
 * Borg ARC CLI -- Repository analysis and selective absorption
 *
 * Usage:
 *   node dist/borg-arc/cli.js analyze <repo-path> [--url <github-url>] [--json]
 *   node dist/borg-arc/cli.js absorb <repo-path> --approved-by jason --target <subdir>
 *   node dist/borg-arc/cli.js history [--json]
 */

import path from 'node:path';
import {
  analyzeLocalRepo,
  enrichWithGitHub,
  generateRecommendation,
} from './analyzer.js';
import type { RepoAnalysis } from './analyzer.js';
import { absorbRepo, getAbsorptionHistory } from './absorb.js';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

async function main(): Promise<void> {
  switch (command) {
    case 'analyze': {
      const repoPath = args[1];
      if (!repoPath) {
        console.error('Usage: borg-arc analyze <repo-path> [--url <github-url>] [--json]');
        process.exit(1);
      }

      const resolvedPath = path.resolve(repoPath);
      const repoUrl = getFlag('--url') ?? `local://${resolvedPath}`;
      const jsonOutput = hasFlag('--json');

      let analysis = analyzeLocalRepo(resolvedPath, repoUrl);

      // Enrich with GitHub API if URL provided
      if (repoUrl.includes('github.com')) {
        analysis = await enrichWithGitHub(analysis, repoUrl);
      }

      const approval = generateRecommendation(analysis);
      const fullAnalysis: RepoAnalysis = { ...analysis, approval };

      if (jsonOutput) {
        console.log(JSON.stringify(fullAnalysis, null, 2));
      } else {
        printAnalysis(fullAnalysis);
      }
      break;
    }

    case 'absorb': {
      const repoPath = args[1];
      const approvedBy = getFlag('--approved-by');
      const target = getFlag('--target');

      if (!repoPath || !approvedBy || !target) {
        console.error('Usage: borg-arc absorb <repo-path> --approved-by jason --target <subdir>');
        console.error('  --approved-by must be "jason"');
        console.error('  --target is the subdirectory under project root (e.g., src/absorbed/repo-name)');
        process.exit(1);
      }

      const resolvedPath = path.resolve(repoPath);
      const repoUrl = getFlag('--url') ?? `local://${resolvedPath}`;

      // Analyze first
      const analysis = analyzeLocalRepo(resolvedPath, repoUrl);
      const approval = generateRecommendation(analysis);

      if (approval.melanieRecommendation === 'skip') {
        console.error(`Melanie recommends SKIP: ${approval.melanieReason}`);
        console.error('Absorption blocked.');
        process.exit(1);
      }

      // For absorb, Jason must explicitly approve
      const fullAnalysis: RepoAnalysis = {
        ...analysis,
        approval: {
          ...approval,
          jasonApproved: true,
        },
      };

      const result = absorbRepo({
        analysis: fullAnalysis,
        sourceDir: resolvedPath,
        targetSubdir: target,
        approvedBy,
      });

      if (hasFlag('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('Borg ARC Absorption Complete');
        console.log(`  Success: ${result.success}`);
        console.log(`  Files absorbed: ${result.filesAbsorbed.length}`);
        if (result.filesBlocked.length > 0) {
          console.log(`  Files BLOCKED (critical findings): ${result.filesBlocked.length}`);
          for (const f of result.filesBlocked) {
            console.log(`    - ${f}`);
          }
        }
        console.log(`  DeepSec findings: ${result.deepsecFindings}`);
        console.log(`  Critical findings: ${result.criticalFindings}`);
      }
      break;
    }

    case 'history': {
      const records = getAbsorptionHistory();
      const jsonOutput = hasFlag('--json');

      if (jsonOutput) {
        console.log(JSON.stringify(records, null, 2));
      } else if (records.length === 0) {
        console.log('No absorption history found.');
      } else {
        console.log('Borg ARC Absorption History:\n');
        for (const r of records) {
          console.log(`  ${r.absorbedAt} | ${r.repoUrl}`);
          console.log(`    Files: ${r.filesAbsorbed.length} | DeepSec: ${r.deepsecScanPassed ? 'PASSED' : 'FAILED'} | Approved by: ${r.approvedBy}`);
          console.log();
        }
        console.log(`Total absorptions: ${records.length}`);
      }
      break;
    }

    default:
      console.log('Borg ARC -- Repository Analysis & Selective Absorption\n');
      console.log('Usage:');
      console.log('  borg-arc analyze <repo-path> [--url <url>] [--json]   Analyze repo');
      console.log('  borg-arc absorb <repo-path> --approved-by jason --target <dir>');
      console.log('  borg-arc history [--json]                              Show audit trail');
      process.exit(1);
  }
}

// -- Display ----------------------------------------------------------------

function printAnalysis(a: RepoAnalysis): void {
  const rec = a.approval.melanieRecommendation.toUpperCase();
  const recEmoji = rec === 'ABSORB' ? '+' : rec === 'SKIP' ? 'X' : '?';

  console.log(`Borg ARC Analysis: ${a.repoName}`);
  console.log(`  URL: ${a.repoUrl}`);
  console.log(`  Analyzed: ${a.analyzedAt}`);
  console.log();

  console.log('Compatibility:');
  console.log(`  Language: ${a.compatibility.language}`);
  console.log(`  License: ${a.compatibility.license} (${a.compatibility.licenseCompatible ? 'compatible' : 'INCOMPATIBLE'})`);
  console.log(`  Dependencies: ${a.compatibility.dependencies.length}`);
  if (a.compatibility.conflictingDeps.length > 0) {
    console.log(`  Conflicts: ${a.compatibility.conflictingDeps.join(', ')}`);
  }
  console.log();

  console.log('Quality:');
  console.log(`  Tests: ${a.quality.hasTests ? 'yes' : 'no'}`);
  console.log(`  Types: ${a.quality.hasTypes ? 'yes' : 'no'}`);
  console.log(`  Last commit: ${a.quality.lastCommitDate || 'unknown'}`);
  console.log(`  Maintained: ${a.quality.maintainerActive ? 'yes' : 'no'}`);
  if (a.quality.stars > 0) console.log(`  Stars: ${a.quality.stars}`);
  console.log();

  console.log('Risk:');
  console.log(`  Security scan required: ${a.risk.securityScanRequired ? 'YES (always)' : 'no'}`);
  console.log(`  Reversibility: ${a.risk.reversibility}`);
  console.log();

  console.log(`Recommendation: [${recEmoji}] ${rec}`);
  console.log(`  ${a.approval.melanieReason}`);
}

main().catch(err => {
  console.error('Borg ARC error:', err.message ?? err);
  process.exit(1);
});
