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

// -- Types ------------------------------------------------------------------

export interface AbsorbOptions {
  analysis: RepoAnalysis;
  sourceDir: string;
  targetSubdir: string;       // e.g., 'src/absorbed/repo-name'
  approvedBy: string;         // must be "jason"
}

export interface AbsorbResult {
  success: boolean;
  filesAbsorbed: string[];
  filesBlocked: string[];
  deepsecFindings: number;
  criticalFindings: number;
  record: AbsorptionRecord;
}

// -- Absorption Engine ------------------------------------------------------

/**
 * Absorb selected files from an analyzed repo into ClaudeClaw.
 *
 * Fail-closed: any file with critical DeepSec findings is blocked.
 * Requires Jason's explicit approval.
 */
export function absorbRepo(options: AbsorbOptions): AbsorbResult {
  const { analysis, sourceDir, targetSubdir, approvedBy } = options;
  const projectRoot = process.env.CLAUDECLAW_PROJECT_ROOT ?? '.';
  const targetDir = path.join(projectRoot, targetSubdir);

  // Safety gates
  if (!analysis.approval.jasonApproved) {
    throw new Error('Cannot absorb without Jason approval');
  }
  if (approvedBy.toLowerCase() !== 'jason') {
    throw new Error('Only Jason can approve absorptions');
  }
  if (analysis.absorptionPlan.targetFiles.length === 0) {
    throw new Error('No target files specified in absorption plan');
  }

  // Create target directory
  fs.mkdirSync(targetDir, { recursive: true });

  const filesAbsorbed: string[] = [];
  const filesBlocked: string[] = [];
  let totalFindings = 0;
  let criticalFindings = 0;

  for (const file of analysis.absorptionPlan.targetFiles) {
    const sourcePath = path.join(sourceDir, file);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const content = fs.readFileSync(sourcePath, 'utf-8');

    // DeepSec scan BEFORE absorption (fail-closed)
    const findings = scanFile(sourcePath, content, ALL_RULES, sourceDir);
    const criticals = findings.filter(f => f.severity === 'critical');
    totalFindings += findings.length;
    criticalFindings += criticals.length;

    if (criticals.length > 0) {
      filesBlocked.push(file);
      continue;
    }

    // Copy file to target
    const targetPath = path.join(targetDir, path.basename(file));
    fs.writeFileSync(targetPath, content, 'utf-8');
    filesAbsorbed.push(path.relative(projectRoot, targetPath).replace(/\\/g, '/'));
  }

  const record: AbsorptionRecord = {
    repoUrl: analysis.repoUrl,
    absorbedAt: new Date().toISOString(),
    filesAbsorbed,
    deepsecScanPassed: criticalFindings === 0,
    approvedBy,
  };

  // Save absorption record to audit trail
  saveRecord(record, projectRoot);

  return {
    success: criticalFindings === 0,
    filesAbsorbed,
    filesBlocked,
    deepsecFindings: totalFindings,
    criticalFindings,
    record,
  };
}

/**
 * Get all past absorption records.
 */
export function getAbsorptionHistory(projectRoot?: string): AbsorptionRecord[] {
  const root = projectRoot ?? process.env.CLAUDECLAW_PROJECT_ROOT ?? '.';
  const historyPath = path.join(root, 'data', 'borg-arc-history.json');
  if (!fs.existsSync(historyPath)) return [];

  try {
    return JSON.parse(fs.readFileSync(historyPath, 'utf-8')) as AbsorptionRecord[];
  } catch {
    return [];
  }
}

// -- Helpers ----------------------------------------------------------------

function saveRecord(record: AbsorptionRecord, projectRoot: string): void {
  const dataDir = path.join(projectRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const historyPath = path.join(dataDir, 'borg-arc-history.json');
  const history = fs.existsSync(historyPath)
    ? JSON.parse(fs.readFileSync(historyPath, 'utf-8')) as AbsorptionRecord[]
    : [];

  history.push(record);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
}
