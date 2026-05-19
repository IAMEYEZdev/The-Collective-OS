import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { analyzeLocalRepo, generateRecommendation } from './analyzer.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('Borg ARC Analyzer', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-test-'));
  });

  it('analyzes ClaudeClaw itself', () => {
    const result = analyzeLocalRepo(PROJECT_ROOT, 'https://github.com/test/claudeclaw');
    expect(result.repoName).toBeTruthy();
    expect(result.compatibility.language).toBe('TypeScript');
    expect(result.compatibility.runtime).toBe('Node.js');
    expect(result.compatibility.dependencies.length).toBeGreaterThan(0);
    expect(result.risk.securityScanRequired).toBe(true);
    expect(result.quality.hasTypes).toBe(true);
  });

  it('detects MIT license', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'LICENSE'), 'MIT License\n\nCopyright...');

    const result = analyzeLocalRepo(tempDir, 'local://test');
    expect(result.compatibility.license).toBe('MIT');
    expect(result.compatibility.licenseCompatible).toBe(true);
  });

  it('flags unknown license as incompatible', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-arc-lic-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    // No license file

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
});

describe('Recommendation Engine', () => {
  function makeAnalysis(overrides: Record<string, unknown> = {}) {
    return {
      repoUrl: 'https://github.com/test/repo',
      repoName: 'repo',
      analyzedAt: new Date().toISOString(),
      compatibility: {
        language: 'TypeScript',
        runtime: 'Node.js',
        dependencies: [],
        conflictingDeps: [],
        licenseCompatible: true,
        license: 'MIT',
        ...overrides.compatibility as object,
      },
      quality: {
        hasTests: true,
        hasTypes: true,
        lastCommitDate: new Date().toISOString(),
        stars: 100,
        openIssues: 5,
        maintainerActive: true,
        ...overrides.quality as object,
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

  it('recommends absorb for good repo', () => {
    const analysis = makeAnalysis();
    const rec = generateRecommendation(analysis);
    expect(rec.melanieRecommendation).toBe('absorb');
    expect(rec.jasonApproved).toBeNull();
  });

  it('recommends skip for incompatible license', () => {
    const analysis = makeAnalysis({
      compatibility: { licenseCompatible: false, license: 'GPL' },
    });
    const rec = generateRecommendation(analysis);
    expect(rec.melanieRecommendation).toBe('skip');
  });

  it('recommends watch for minor concerns', () => {
    const analysis = makeAnalysis({
      quality: { hasTests: false },
    });
    const rec = generateRecommendation(analysis);
    expect(rec.melanieRecommendation).toBe('watch');
  });

  it('recommends skip for 3+ issues', () => {
    const analysis = makeAnalysis({
      quality: { hasTests: false, hasTypes: false, maintainerActive: false },
    });
    const rec = generateRecommendation(analysis);
    expect(rec.melanieRecommendation).toBe('skip');
  });

  it('jason approval starts as null', () => {
    const analysis = makeAnalysis();
    const rec = generateRecommendation(analysis);
    expect(rec.jasonApproved).toBeNull();
  });
});
