import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { absorbRepo, getAbsorptionHistory } from './absorb.js';
import type { RepoAnalysis } from './analyzer.js';

function makeApprovedAnalysis(targetFiles: string[]): RepoAnalysis {
  return {
    repoUrl: 'https://github.com/test/repo',
    repoName: 'test-repo',
    analyzedAt: new Date().toISOString(),
    compatibility: {
      language: 'TypeScript',
      runtime: 'Node.js',
      dependencies: [],
      conflictingDeps: [],
      licenseCompatible: true,
      license: 'MIT',
    },
    quality: {
      hasTests: true,
      hasTypes: true,
      lastCommitDate: new Date().toISOString(),
      stars: 50,
      openIssues: 2,
      maintainerActive: true,
    },
    absorptionPlan: {
      targetFiles,
      estimatedLines: 100,
      integrationPoint: 'src/utils',
      adaptationNeeded: [],
    },
    risk: {
      securityScanRequired: true,
      breakingChanges: [],
      reversibility: 'easy',
    },
    approval: {
      melanieRecommendation: 'absorb',
      melanieReason: 'Test approval',
      jasonApproved: true,
    },
  };
}

describe('Borg ARC Absorption', () => {
  let sourceDir: string;
  let targetRoot: string;

  beforeEach(() => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-src-'));
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-target-'));
    process.env.CLAUDECLAW_PROJECT_ROOT = targetRoot;
  });

  it('throws without Jason approval', () => {
    const analysis = makeApprovedAnalysis(['file.ts']);
    analysis.approval.jasonApproved = false;

    expect(() => absorbRepo({
      analysis,
      sourceDir,
      targetSubdir: 'absorbed',
      approvedBy: 'jason',
    })).toThrow('Cannot absorb without Jason approval');
  });

  it('throws if approvedBy is not jason', () => {
    const analysis = makeApprovedAnalysis(['file.ts']);

    expect(() => absorbRepo({
      analysis,
      sourceDir,
      targetSubdir: 'absorbed',
      approvedBy: 'someone-else',
    })).toThrow('Only Jason can approve');
  });

  it('throws with empty target files', () => {
    const analysis = makeApprovedAnalysis([]);

    expect(() => absorbRepo({
      analysis,
      sourceDir,
      targetSubdir: 'absorbed',
      approvedBy: 'jason',
    })).toThrow('No target files');
  });

  it('absorbs clean files successfully', () => {
    // Create a clean source file
    fs.writeFileSync(path.join(sourceDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }');

    const analysis = makeApprovedAnalysis(['utils.ts']);
    const result = absorbRepo({
      analysis,
      sourceDir,
      targetSubdir: 'absorbed',
      approvedBy: 'jason',
    });

    expect(result.success).toBe(true);
    expect(result.filesAbsorbed).toHaveLength(1);
    expect(result.filesBlocked).toHaveLength(0);
    expect(result.record.deepsecScanPassed).toBe(true);
    expect(result.record.approvedBy).toBe('jason');
  });

  it('skips nonexistent source files gracefully', () => {
    const analysis = makeApprovedAnalysis(['nonexistent.ts']);
    const result = absorbRepo({
      analysis,
      sourceDir,
      targetSubdir: 'absorbed',
      approvedBy: 'jason',
    });

    expect(result.filesAbsorbed).toHaveLength(0);
  });

  it('saves absorption record to history', () => {
    fs.writeFileSync(path.join(sourceDir, 'clean.ts'), 'const x = 1;');

    const analysis = makeApprovedAnalysis(['clean.ts']);
    absorbRepo({
      analysis,
      sourceDir,
      targetSubdir: 'absorbed',
      approvedBy: 'jason',
    });

    const history = getAbsorptionHistory(targetRoot);
    expect(history).toHaveLength(1);
    expect(history[0].repoUrl).toBe('https://github.com/test/repo');
    expect(history[0].approvedBy).toBe('jason');
  });

  it('returns empty history when none exists', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-empty-'));
    const history = getAbsorptionHistory(emptyDir);
    expect(history).toHaveLength(0);
  });
});
