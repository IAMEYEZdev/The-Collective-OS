import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { analyzeLocalRepo, generateRecommendation } from './analyzer.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('Borg ARC v2 Analyzer', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-test-'));
  });

  it('analyzes ClaudeClaw itself (v2 fields present)', () => {
    const result = analyzeLocalRepo(PROJECT_ROOT, 'https://github.com/test/claudeclaw');
    expect(result.version).toBe(2);
    expect(result.repoName).toBeTruthy();
    expect(result.compatibility.language).toBe('TypeScript');
    expect(result.compatibility.languages.primary).toBe('TypeScript');
    expect(result.compatibility.languages.hasTypes).toBe(true);
    expect(result.compatibility.languages.all).toContain('TypeScript');
    expect(result.compatibility.dependencies.length).toBeGreaterThan(0);
    expect(result.risk.securityScanRequired).toBe(true);
    expect(result.quality.hasTypes).toBe(true);
    // v2 fields
    expect(result.complexity.totalFiles).toBeGreaterThan(0);
    expect(result.complexity.estimatedLOC).toBeGreaterThan(0);
    expect(result.quality.documentation).toBeDefined();
    expect(result.quality.ci).toBeDefined();
    expect(result.forkability).toBeDefined();
    expect(result.monorepo).toBeDefined();
  });

  it('detects MIT license', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'LICENSE'), 'MIT License\n\nCopyright...');

    const result = analyzeLocalRepo(tempDir, 'local://test');
    expect(result.compatibility.license).toBe('MIT');
    expect(result.compatibility.licenseCompatible).toBe(true);
    expect(result.compatibility.licenseDetail.spdx).toBe('MIT');
    expect(result.compatibility.licenseDetail.compatible).toBe(true);
  });

  it('detects MIT license from grant clause (split-license files)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-splitlic-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'LICENSE'), [
      'Copyright (c) 2023 Langfuse GmbH',
      '',
      'The "Software" is...',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction...',
    ].join('\n'));

    const result = analyzeLocalRepo(dir, 'local://test-split-license');
    expect(result.compatibility.license).toBe('MIT');
    expect(result.compatibility.licenseCompatible).toBe(true);
  });

  it('detects TypeScript in monorepo sub-packages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-mono-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'packages', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'shared', 'tsconfig.json'), '{}');

    const result = analyzeLocalRepo(dir, 'local://test-monorepo');
    expect(result.quality.hasTypes).toBe(true);
    expect(result.compatibility.language).toBe('TypeScript');
  });

  it('flags unknown license as incompatible', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-lic-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');

    const result = analyzeLocalRepo(dir, 'local://test');
    expect(result.compatibility.license).toBe('UNKNOWN');
    expect(result.compatibility.licenseCompatible).toBe(false);
  });

  it('detects test presence via directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-test2-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'test'));

    const result = analyzeLocalRepo(dir, 'local://test');
    expect(result.quality.hasTests).toBe(true);
  });

  it('detects TypeScript via tsconfig', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-ts-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');

    const result = analyzeLocalRepo(dir, 'local://test');
    expect(result.quality.hasTypes).toBe(true);
    expect(result.compatibility.language).toBe('TypeScript');
  });

  it('always requires security scan', () => {
    const result = analyzeLocalRepo(tempDir, 'local://test');
    expect(result.risk.securityScanRequired).toBe(true);
  });

  // v2: Multi-language detection
  it('detects Python repos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-py-'));
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "test"');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\n');

    const result = analyzeLocalRepo(dir, 'local://test-python');
    expect(result.compatibility.languages.primary).toBe('Python');
    expect(result.compatibility.languages.runtime).toBe('Python');
    expect(result.compatibility.languages.all).toContain('Python');
  });

  it('detects Go repos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-go-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module github.com/test/repo\ngo 1.21');

    const result = analyzeLocalRepo(dir, 'local://test-go');
    expect(result.compatibility.languages.primary).toBe('Go');
    expect(result.compatibility.languages.runtime).toBe('Go');
    expect(result.compatibility.languages.hasTypes).toBe(true);  // Go is typed
  });

  it('detects Rust repos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-rs-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "test"');

    const result = analyzeLocalRepo(dir, 'local://test-rust');
    expect(result.compatibility.languages.primary).toBe('Rust');
    expect(result.compatibility.languages.hasTypes).toBe(true);
  });

  // v2: EE directory detection
  it('detects EE directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-ee-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT License\n\nCopyright...');
    fs.mkdirSync(path.join(dir, 'ee'));
    fs.writeFileSync(path.join(dir, 'ee', 'feature.ts'), 'export const x = 1;');

    const result = analyzeLocalRepo(dir, 'local://test-ee');
    expect(result.compatibility.licenseDetail.hasEERestrictions).toBe(true);
    expect(result.compatibility.licenseDetail.eeDirs).toContain('ee');
  });

  // v2: Complexity metrics
  it('measures repository complexity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-complex-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), 'export const x = 1;');

    const result = analyzeLocalRepo(dir, 'local://test-complex');
    expect(result.complexity.totalFiles).toBeGreaterThan(0);
    expect(result.complexity.topLevelDirs).toContain('src');
  });

  // v2: Monorepo detection
  it('detects npm workspaces monorepo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-workspace-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      workspaces: ['packages/*'],
    }));
    fs.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'core', 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'web', 'package.json'), '{}');

    const result = analyzeLocalRepo(dir, 'local://test-monorepo');
    expect(result.monorepo.isMonorepo).toBe(true);
    expect(result.monorepo.workspaceManager).toBe('npm');
    expect(result.monorepo.packageCount).toBe(2);
  });

  // v2: Documentation health
  it('scores documentation health', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-docs-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
    fs.writeFileSync(path.join(dir, 'CONTRIBUTING.md'), 'How to contribute');
    fs.mkdirSync(path.join(dir, 'docs'));

    const result = analyzeLocalRepo(dir, 'local://test-docs');
    expect(result.quality.documentation.hasReadme).toBe(true);
    expect(result.quality.documentation.hasContributing).toBe(true);
    expect(result.quality.documentation.hasDocsDir).toBe(true);
    expect(result.quality.documentation.score).toBeGreaterThanOrEqual(70);
  });

  // v2: CI detection
  it('detects GitHub Actions CI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-ci-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI');

    const result = analyzeLocalRepo(dir, 'local://test-ci');
    expect(result.quality.ci.hasCI).toBe(true);
    expect(result.quality.ci.platforms).toContain('github-actions');
  });

  // v2: Forkability assessment
  it('recommends fork-full for small clean repos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-fork-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT License');
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export default 1;');

    const result = analyzeLocalRepo(dir, 'local://test-fork');
    expect(result.forkability.strategy).toBe('fork-full');
    expect(result.forkability.forkabilityScore).toBeGreaterThanOrEqual(80);
  });

  // v2: Auto-set reversibility based on size
  it('sets reversibility based on file count', () => {
    // Small repo = easy
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-rev-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');

    const result = analyzeLocalRepo(dir, 'local://test');
    expect(result.risk.reversibility).toBe('easy');

    // ClaudeClaw itself should be medium or hard
    const self = analyzeLocalRepo(PROJECT_ROOT, 'local://self');
    expect(['medium', 'hard']).toContain(self.risk.reversibility);
  });
});

describe('v2 Recommendation Engine (Weighted Scoring)', () => {
  function makeAnalysis(overrides: Record<string, unknown> = {}) {
    return {
      repoUrl: 'https://github.com/test/repo',
      repoName: 'repo',
      analyzedAt: new Date().toISOString(),
      version: 2 as const,
      compatibility: {
        language: 'TypeScript',
        runtime: 'Node.js',
        languages: {
          primary: 'TypeScript',
          all: ['TypeScript'],
          runtime: 'Node.js',
          hasTypes: true,
        },
        dependencies: [],
        conflictingDeps: [],
        licenseCompatible: true,
        license: 'MIT',
        licenseDetail: {
          spdx: 'MIT',
          compatible: true,
          hasEERestrictions: false,
          eeDirs: [],
          dualLicense: false,
          licenseFiles: ['LICENSE'],
        },
        ...overrides.compatibility as object,
      },
      quality: {
        hasTests: true,
        hasTypes: true,
        lastCommitDate: new Date().toISOString(),
        stars: 100,
        openIssues: 5,
        maintainerActive: true,
        documentation: { hasReadme: true, hasContributing: true, hasChangelog: true, hasDocsDir: true, hasSecurityPolicy: false, hasCodeOfConduct: false, score: 85 },
        ci: { hasCI: true, platforms: ['github-actions'] },
        ...overrides.quality as object,
      },
      complexity: {
        totalFiles: 50,
        totalDirs: 10,
        estimatedLOC: 2000,
        maxDepth: 4,
        topLevelDirs: ['src', 'test'],
        ...overrides.complexity as object,
      },
      monorepo: {
        isMonorepo: false,
        workspaceManager: null,
        packages: [],
        packageCount: 0,
        ...overrides.monorepo as object,
      },
      forkability: {
        strategy: 'fork-full' as const,
        reason: 'Clean and small',
        forkableFiles: 50,
        proprietaryFiles: 0,
        forkabilityScore: 95,
        ...overrides.forkability as object,
      },
      absorptionPlan: {
        targetFiles: [],
        estimatedLines: 0,
        integrationPoint: '',
        adaptationNeeded: [],
      },
      risk: {
        securityScanRequired: true,
        breakingChanges: [],
        reversibility: 'easy' as const,
      },
    };
  }

  it('recommends absorb for good repo with high score', () => {
    const analysis = makeAnalysis();
    const rec = generateRecommendation(analysis);
    expect(rec.melanieRecommendation).toBe('absorb');
    expect(rec.melanieScore).toBeGreaterThanOrEqual(80);
    expect(rec.jasonApproved).toBeNull();
    expect(rec.scoreBreakdown).toBeDefined();
  });

  it('returns score breakdown with all signals', () => {
    const analysis = makeAnalysis();
    const rec = generateRecommendation(analysis);
    expect(rec.scoreBreakdown).toHaveProperty('license');
    expect(rec.scoreBreakdown).toHaveProperty('quality');
    expect(rec.scoreBreakdown).toHaveProperty('maintenance');
    expect(rec.scoreBreakdown).toHaveProperty('forkability');
    expect(rec.scoreBreakdown).toHaveProperty('documentation');
    expect(rec.scoreBreakdown).toHaveProperty('ci');
  });

  it('recommends skip for incompatible license (absolute blocker)', () => {
    const analysis = makeAnalysis({
      compatibility: {
        licenseCompatible: false,
        license: 'GPL',
        licenseDetail: { spdx: 'GPL', compatible: false, hasEERestrictions: false, eeDirs: [], dualLicense: false, licenseFiles: ['LICENSE'] },
      },
    });
    const rec = generateRecommendation(analysis);
    expect(rec.melanieRecommendation).toBe('skip');
    expect(rec.melanieScore).toBe(0);
  });

  it('recommends watch for mixed signals', () => {
    const analysis = makeAnalysis({
      quality: {
        hasTests: false,
        hasTypes: true,
        maintainerActive: true,
        lastCommitDate: new Date().toISOString(),
        documentation: { hasReadme: true, hasContributing: false, hasChangelog: false, hasDocsDir: false, hasSecurityPolicy: false, hasCodeOfConduct: false, score: 40 },
        ci: { hasCI: false, platforms: [] },
      },
      forkability: {
        strategy: 'extract-selective',
        reason: 'Large repo',
        forkableFiles: 100,
        proprietaryFiles: 50,
        forkabilityScore: 60,
      },
    });
    const rec = generateRecommendation(analysis);
    // Should be watch or skip depending on weighted score
    expect(['watch', 'skip']).toContain(rec.melanieRecommendation);
    expect(rec.melanieScore).toBeLessThan(80);
  });

  it('penalizes EE restrictions in license score', () => {
    const cleanAnalysis = makeAnalysis();
    const eeAnalysis = makeAnalysis({
      compatibility: {
        licenseCompatible: true,
        license: 'MIT',
        licenseDetail: { spdx: 'MIT', compatible: true, hasEERestrictions: true, eeDirs: ['ee', 'packages/ee'], dualLicense: true, licenseFiles: ['LICENSE'] },
      },
    });

    const cleanRec = generateRecommendation(cleanAnalysis);
    const eeRec = generateRecommendation(eeAnalysis);

    expect(eeRec.scoreBreakdown.license.score).toBeLessThan(cleanRec.scoreBreakdown.license.score);
  });

  it('penalizes unmaintained repos', () => {
    const analysis = makeAnalysis({
      quality: {
        hasTests: true,
        hasTypes: true,
        maintainerActive: false,
        lastCommitDate: '2024-01-01T00:00:00Z',
        documentation: { hasReadme: true, hasContributing: false, hasChangelog: false, hasDocsDir: false, hasSecurityPolicy: false, hasCodeOfConduct: false, score: 40 },
        ci: { hasCI: true, platforms: ['github-actions'] },
      },
    });
    const rec = generateRecommendation(analysis);
    expect(rec.scoreBreakdown.maintenance.score).toBeLessThan(50);
  });

  it('jason approval starts as null', () => {
    const analysis = makeAnalysis();
    const rec = generateRecommendation(analysis);
    expect(rec.jasonApproved).toBeNull();
  });
});
