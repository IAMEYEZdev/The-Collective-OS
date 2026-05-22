#!/usr/bin/env node
/**
 * Borg ARC v2 CLI -- Repository analysis and selective absorption
 *
 * Usage:
 *   node dist/borg-arc/cli.js analyze <repo-path> [--url <github-url>] [--json]
 *   node dist/borg-arc/cli.js absorb <repo-path> --approved-by jason --target <subdir>
 *   node dist/borg-arc/cli.js history [--json]
 *   node dist/borg-arc/cli.js score <repo-path> [--url <github-url>]   (quick score only)
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

    case 'score': {
      // Quick score: just run analysis and show score breakdown
      const repoPath = args[1];
      if (!repoPath) {
        console.error('Usage: borg-arc score <repo-path> [--url <github-url>]');
        process.exit(1);
      }

      const resolvedPath = path.resolve(repoPath);
      const repoUrl = getFlag('--url') ?? `local://${resolvedPath}`;

      let analysis = analyzeLocalRepo(resolvedPath, repoUrl);
      if (repoUrl.includes('github.com')) {
        analysis = await enrichWithGitHub(analysis, repoUrl);
      }

      const approval = generateRecommendation(analysis);
      console.log(`Borg ARC Score: ${path.basename(resolvedPath)}`);
      console.log(`  Overall: ${approval.melanieScore}/100 -> ${approval.melanieRecommendation.toUpperCase()}`);
      console.log();
      for (const [name, s] of Object.entries(approval.scoreBreakdown)) {
        const bar = '█'.repeat(Math.round(s.score / 10)) + '░'.repeat(10 - Math.round(s.score / 10));
        console.log(`  ${name.padEnd(15)} ${bar} ${String(s.score).padStart(3)}/100 (w:${s.weight}) ${s.detail}`);
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
        console.error('  --target is the subdirectory under project root');
        process.exit(1);
      }

      const resolvedPath = path.resolve(repoPath);
      const repoUrl = getFlag('--url') ?? `local://${resolvedPath}`;

      const analysis = analyzeLocalRepo(resolvedPath, repoUrl);
      const approval = generateRecommendation(analysis);

      if (approval.melanieRecommendation === 'skip') {
        console.error(`Melanie recommends SKIP (score: ${approval.melanieScore}/100): ${approval.melanieReason}`);
        console.error('Absorption blocked.');
        process.exit(1);
      }

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
      console.log('Borg ARC v2 -- Repository Analysis & Selective Absorption\n');
      console.log('Usage:');
      console.log('  borg-arc analyze <repo-path> [--url <url>] [--json]   Full analysis');
      console.log('  borg-arc score <repo-path> [--url <url>]              Quick score');
      console.log('  borg-arc absorb <repo-path> --approved-by jason --target <dir>');
      console.log('  borg-arc history [--json]                              Audit trail');
      process.exit(1);
  }
}

// -- Display ----------------------------------------------------------------

function printAnalysis(a: RepoAnalysis): void {
  const rec = a.approval.melanieRecommendation.toUpperCase();
  const recEmoji = rec === 'ABSORB' ? '+' : rec === 'SKIP' ? 'X' : '?';

  console.log(`Borg ARC v2 Analysis: ${a.repoName}`);
  console.log(`  URL: ${a.repoUrl}`);
  console.log(`  Analyzed: ${a.analyzedAt}`);
  console.log();

  // Compatibility
  console.log('Compatibility:');
  console.log(`  Primary language: ${a.compatibility.languages.primary}`);
  if (a.compatibility.languages.all.length > 1) {
    console.log(`  All languages: ${a.compatibility.languages.all.join(', ')}`);
  }
  console.log(`  Runtime: ${a.compatibility.languages.runtime}`);
  console.log(`  License: ${a.compatibility.license} (${a.compatibility.licenseCompatible ? 'compatible' : 'INCOMPATIBLE'})`);
  if (a.compatibility.licenseDetail.hasEERestrictions) {
    console.log(`  EE restrictions: YES (${a.compatibility.licenseDetail.eeDirs.join(', ')})`);
  }
  if (a.compatibility.licenseDetail.dualLicense) {
    console.log('  Dual-licensed: YES');
  }
  console.log(`  Dependencies: ${a.compatibility.dependencies.length}`);
  if (a.compatibility.conflictingDeps.length > 0) {
    console.log(`  Conflicts: ${a.compatibility.conflictingDeps.join(', ')}`);
  }
  console.log();

  // Quality
  console.log('Quality:');
  console.log(`  Tests: ${a.quality.hasTests ? 'yes' : 'no'}`);
  console.log(`  Types: ${a.quality.hasTypes ? 'yes' : 'no'}`);
  console.log(`  Last commit: ${a.quality.lastCommitDate || 'unknown'}`);
  console.log(`  Maintained: ${a.quality.maintainerActive ? 'yes' : 'no'}`);
  if (a.quality.stars > 0) console.log(`  Stars: ${a.quality.stars}`);
  console.log(`  Documentation: ${a.quality.documentation.score}/100`);
  if (a.quality.ci.hasCI) {
    console.log(`  CI/CD: ${a.quality.ci.platforms.join(', ')}`);
  }
  console.log();

  // Complexity (v2)
  console.log('Complexity:');
  console.log(`  Files: ${a.complexity.totalFiles} | Dirs: ${a.complexity.totalDirs}`);
  console.log(`  Est. LOC: ${a.complexity.estimatedLOC.toLocaleString()}`);
  console.log(`  Max depth: ${a.complexity.maxDepth}`);
  console.log(`  Structure: ${a.complexity.topLevelDirs.join(', ')}`);
  console.log();

  // Monorepo (v2)
  if (a.monorepo.isMonorepo) {
    console.log('Monorepo:');
    console.log(`  Manager: ${a.monorepo.workspaceManager}`);
    console.log(`  Packages: ${a.monorepo.packageCount}`);
    if (a.monorepo.packages.length <= 10) {
      for (const p of a.monorepo.packages) console.log(`    - ${p}`);
    }
    console.log();
  }

  // Forkability (v2)
  console.log('Forkability:');
  console.log(`  Strategy: ${a.forkability.strategy.toUpperCase()}`);
  console.log(`  Score: ${a.forkability.forkabilityScore}/100`);
  console.log(`  Forkable: ${a.forkability.forkableFiles} files | Proprietary: ${a.forkability.proprietaryFiles} files`);
  console.log(`  ${a.forkability.reason}`);
  console.log();

  // Risk
  console.log('Risk:');
  console.log(`  Security scan required: YES (always)`);
  console.log(`  Reversibility: ${a.risk.reversibility}`);
  console.log();

  // Score Breakdown (v2)
  console.log('Score Breakdown:');
  for (const [name, s] of Object.entries(a.approval.scoreBreakdown)) {
    const bar = '█'.repeat(Math.round(s.score / 10)) + '░'.repeat(10 - Math.round(s.score / 10));
    console.log(`  ${name.padEnd(15)} ${bar} ${String(s.score).padStart(3)}/100 (w:${s.weight}) ${s.detail}`);
  }
  console.log();

  // Recommendation
  console.log(`Recommendation: [${recEmoji}] ${rec} (${a.approval.melanieScore}/100)`);
  console.log(`  ${a.approval.melanieReason}`);
}

main().catch(err => {
  console.error('Borg ARC error:', err.message ?? err);
  process.exit(1);
});
