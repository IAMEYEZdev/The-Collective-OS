/**
 * Borg ARC v2 -- Repository Analysis & Selective Absorption
 *
 * Evaluates GitHub repos for integration into ClaudeClaw.
 * Produces structured analysis: compatibility, quality, risk, absorption plan.
 * Every absorption requires human approval (Melanie recommends, Jason confirms).
 *
 * v2 enhancements:
 *   - Multi-language detection (Python, Go, Rust, Java, not just JS/TS)
 *   - Repository complexity metrics (files, LOC, depth)
 *   - EE/proprietary directory detection
 *   - Forkability assessment with strategy recommendation
 *   - Weighted scoring engine (0-100) replacing boolean issue counting
 *   - Monorepo structure analysis
 *   - Documentation & community health signals
 *   - CI/CD presence detection
 */

import fs from 'node:fs';
import path from 'node:path';

// -- Types ------------------------------------------------------------------

export interface LanguageInfo {
  primary: string;
  all: string[];
  runtime: string;
  hasTypes: boolean;
}

export interface LicenseInfo {
  spdx: string;
  compatible: boolean;
  hasEERestrictions: boolean;
  eeDirs: string[];
  dualLicense: boolean;
  licenseFiles: string[];
}

export interface ComplexityMetrics {
  totalFiles: number;
  totalDirs: number;
  estimatedLOC: number;
  maxDepth: number;
  topLevelDirs: string[];
}

export interface MonorepoInfo {
  isMonorepo: boolean;
  workspaceManager: 'npm' | 'yarn' | 'pnpm' | 'lerna' | 'turborepo' | 'nx' | null;
  packages: string[];
  packageCount: number;
}

export interface DocumentationHealth {
  hasReadme: boolean;
  hasContributing: boolean;
  hasChangelog: boolean;
  hasDocsDir: boolean;
  hasSecurityPolicy: boolean;
  hasCodeOfConduct: boolean;
  score: number;  // 0-100
}

export interface CIPresence {
  hasCI: boolean;
  platforms: string[];  // e.g. ['github-actions', 'circleci']
}

export interface ForkabilityAssessment {
  strategy: 'fork-full' | 'extract-selective' | 'self-host' | 'pattern-study' | 'skip';
  reason: string;
  forkableFiles: number;
  proprietaryFiles: number;
  forkabilityScore: number;  // 0-100
}

export interface RepoAnalysis {
  repoUrl: string;
  repoName: string;
  analyzedAt: string;
  version: 2;

  compatibility: {
    language: string;        // kept for backward compat
    runtime: string;         // kept for backward compat
    languages: LanguageInfo; // v2: detailed language info
    dependencies: string[];
    conflictingDeps: string[];
    licenseCompatible: boolean;
    license: string;         // kept for backward compat
    licenseDetail: LicenseInfo;  // v2: detailed license info
  };

  quality: {
    hasTests: boolean;
    hasTypes: boolean;
    lastCommitDate: string;
    stars: number;
    openIssues: number;
    maintainerActive: boolean;
    documentation: DocumentationHealth;  // v2
    ci: CIPresence;                       // v2
  };

  complexity: ComplexityMetrics;  // v2
  monorepo: MonorepoInfo;        // v2
  forkability: ForkabilityAssessment;  // v2

  absorptionPlan: {
    targetFiles: string[];
    estimatedLines: number;
    integrationPoint: string;
    adaptationNeeded: string[];
  };

  risk: {
    securityScanRequired: boolean;
    breakingChanges: string[];
    reversibility: 'easy' | 'medium' | 'hard';
  };

  approval: {
    melanieRecommendation: 'absorb' | 'skip' | 'watch';
    melanieReason: string;
    melanieScore: number;      // v2: 0-100 weighted score
    scoreBreakdown: Record<string, { score: number; weight: number; detail: string }>;  // v2
    jasonApproved: boolean | null;
  };
}

export interface AbsorptionRecord {
  repoUrl: string;
  absorbedAt: string;
  filesAbsorbed: string[];
  deepsecScanPassed: boolean;
  approvedBy: string;
}

// -- Constants ---------------------------------------------------------------

const COMPATIBLE_LICENSES = ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause'];

const EE_DIR_PATTERNS = [
  'ee', 'enterprise', 'pro', 'premium', 'commercial',
  'ee-', '-ee', 'packages/ee', 'apps/ee',
];

const PROPRIETARY_MARKERS = [
  'All rights reserved',
  'proprietary',
  'commercial license',
  'Enterprise Edition',
  'not open source',
  'Business Source License',
  'BUSL',
  'Elastic License',
  'Server Side Public License',
  'SSPL',
];

// File extensions to count for LOC estimation
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyx',
  '.go',
  '.rs',
  '.java', '.kt', '.scala',
  '.rb',
  '.c', '.cpp', '.h', '.hpp',
  '.cs',
  '.swift',
  '.vue', '.svelte',
]);

// -- Analyzer ---------------------------------------------------------------

/**
 * Analyze a local clone of a repository for absorption potential.
 * Returns everything except approval (filled by generateRecommendation).
 */
export function analyzeLocalRepo(
  repoPath: string,
  repoUrl: string
): Omit<RepoAnalysis, 'approval'> {
  const pkgPath = path.join(repoPath, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  const pkg = hasPkg ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) : {};

  // Language detection (v2: multi-language)
  const languages = detectLanguages(repoPath, pkg);

  // Test detection (expanded)
  const hasTests = detectTests(repoPath, pkg);

  // License detection (v2: detailed)
  const licenseDetail = detectLicenseDetail(repoPath);

  // Dependencies
  const deps = Object.keys(pkg.dependencies ?? {});
  const conflicting = findConflictingDeps(deps);

  // Git history
  const lastCommitDate = getLastCommitDate(repoPath);
  const maintainerActive = isRecentlyMaintained(lastCommitDate);

  // v2: Complexity metrics
  const complexity = measureComplexity(repoPath);

  // v2: Monorepo detection
  const monorepo = detectMonorepo(repoPath, pkg);

  // v2: Documentation health
  const documentation = assessDocumentation(repoPath);

  // v2: CI presence
  const ci = detectCI(repoPath);

  // v2: Forkability
  const forkability = assessForkability(repoPath, licenseDetail, complexity);

  return {
    repoUrl,
    repoName: path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    version: 2,
    compatibility: {
      language: languages.primary,
      runtime: languages.runtime,
      languages,
      dependencies: deps,
      conflictingDeps: conflicting,
      licenseCompatible: licenseDetail.compatible,
      license: licenseDetail.spdx,
      licenseDetail,
    },
    quality: {
      hasTests: !!hasTests,
      hasTypes: languages.hasTypes,
      lastCommitDate,
      stars: 0,
      openIssues: 0,
      maintainerActive,
      documentation,
      ci,
    },
    complexity,
    monorepo,
    forkability,
    absorptionPlan: {
      targetFiles: [],
      estimatedLines: 0,
      integrationPoint: '',
      adaptationNeeded: [],
    },
    risk: {
      securityScanRequired: true,
      breakingChanges: [],
      reversibility: complexity.totalFiles > 500 ? 'hard'
        : complexity.totalFiles > 100 ? 'medium'
        : 'easy',
    },
  };
}

/**
 * Enrich analysis with GitHub API data (stars, issues).
 */
export async function enrichWithGitHub(
  analysis: Omit<RepoAnalysis, 'approval'>,
  repoUrl: string
): Promise<Omit<RepoAnalysis, 'approval'>> {
  try {
    const { owner, repo } = parseGitHubUrl(repoUrl);
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (!response.ok) return analysis;

    const data = await response.json() as {
      stargazers_count: number;
      open_issues_count: number;
    };

    return {
      ...analysis,
      quality: {
        ...analysis.quality,
        stars: data.stargazers_count,
        openIssues: data.open_issues_count,
      },
    };
  } catch {
    return analysis;
  }
}

// -- Weighted Recommendation Engine (v2) ------------------------------------

interface ScoreSignal {
  name: string;
  weight: number;
  score: number;   // 0-100
  detail: string;
}

/**
 * v2 Recommendation Engine: Weighted scoring instead of boolean counting.
 *
 * Each signal contributes a weighted score (0-100). Final score determines:
 *   80-100: ABSORB (strong candidate)
 *   50-79:  WATCH (potential, needs monitoring or conditions)
 *   0-49:   SKIP (too many risks)
 *
 * License incompatibility is still an absolute blocker (score = 0).
 */
export function generateRecommendation(
  analysis: Omit<RepoAnalysis, 'approval'>
): RepoAnalysis['approval'] {
  // Absolute blocker: license
  if (!analysis.compatibility.licenseCompatible) {
    return {
      melanieRecommendation: 'skip',
      melanieReason: `License incompatible (${analysis.compatibility.license}). Cannot absorb.`,
      melanieScore: 0,
      scoreBreakdown: {
        license: { score: 0, weight: 1, detail: `Incompatible: ${analysis.compatibility.license}` },
      },
      jasonApproved: null,
    };
  }

  const signals: ScoreSignal[] = [
    // License (25% weight) - already passed blocker, score based on EE risk
    {
      name: 'license',
      weight: 25,
      score: analysis.compatibility.licenseDetail?.hasEERestrictions ? 60 : 100,
      detail: analysis.compatibility.licenseDetail?.hasEERestrictions
        ? `${analysis.compatibility.license} with EE restrictions (${analysis.compatibility.licenseDetail.eeDirs.length} dirs)`
        : `Clean ${analysis.compatibility.license}`,
    },

    // Code quality (20% weight)
    {
      name: 'quality',
      weight: 20,
      score: computeQualityScore(analysis),
      detail: buildQualityDetail(analysis),
    },

    // Maintenance health (20% weight)
    {
      name: 'maintenance',
      weight: 20,
      score: analysis.quality.maintainerActive ? 100
        : analysis.quality.lastCommitDate ? 30 : 0,
      detail: analysis.quality.maintainerActive
        ? `Active (last commit: ${analysis.quality.lastCommitDate.slice(0, 10)})`
        : `Inactive${analysis.quality.lastCommitDate ? ` (last: ${analysis.quality.lastCommitDate.slice(0, 10)})` : ''}`,
    },

    // Forkability (15% weight)
    {
      name: 'forkability',
      weight: 15,
      score: analysis.forkability?.forkabilityScore ?? 50,
      detail: analysis.forkability
        ? `Strategy: ${analysis.forkability.strategy} (${analysis.forkability.forkableFiles} forkable / ${analysis.forkability.proprietaryFiles} proprietary)`
        : 'Not assessed',
    },

    // Documentation & community (10% weight)
    {
      name: 'documentation',
      weight: 10,
      score: analysis.quality.documentation?.score ?? 50,
      detail: `Doc score: ${analysis.quality.documentation?.score ?? 'N/A'}/100`,
    },

    // CI/CD (10% weight)
    {
      name: 'ci',
      weight: 10,
      score: analysis.quality.ci?.hasCI ? 100 : 30,
      detail: analysis.quality.ci?.hasCI
        ? `CI: ${analysis.quality.ci.platforms.join(', ')}`
        : 'No CI detected',
    },
  ];

  // Calculate weighted score
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const weightedScore = Math.round(
    signals.reduce((sum, s) => sum + (s.score * s.weight), 0) / totalWeight
  );

  // Build breakdown
  const scoreBreakdown: Record<string, { score: number; weight: number; detail: string }> = {};
  for (const s of signals) {
    scoreBreakdown[s.name] = { score: s.score, weight: s.weight, detail: s.detail };
  }

  // Decision thresholds
  let recommendation: 'absorb' | 'watch' | 'skip';
  let reason: string;

  if (weightedScore >= 80) {
    recommendation = 'absorb';
    const topSignals = signals.filter(s => s.score >= 80).map(s => s.name);
    reason = `Strong candidate (score: ${weightedScore}/100). Strengths: ${topSignals.join(', ')}.`;
  } else if (weightedScore >= 50) {
    recommendation = 'watch';
    const weakSignals = signals.filter(s => s.score < 60).map(s => `${s.name} (${s.score})`);
    reason = `Potential (score: ${weightedScore}/100). Weak areas: ${weakSignals.join(', ')}.`;
  } else {
    recommendation = 'skip';
    const failSignals = signals.filter(s => s.score < 40).map(s => `${s.name} (${s.score})`);
    reason = `Too risky (score: ${weightedScore}/100). Failures: ${failSignals.join(', ')}.`;
  }

  return {
    melanieRecommendation: recommendation,
    melanieReason: reason,
    melanieScore: weightedScore,
    scoreBreakdown,
    jasonApproved: null,
  };
}

function computeQualityScore(analysis: Omit<RepoAnalysis, 'approval'>): number {
  let score = 0;
  if (analysis.quality.hasTests) score += 35;
  if (analysis.quality.hasTypes) score += 35;
  if (analysis.compatibility.conflictingDeps.length === 0) score += 15;
  if (analysis.compatibility.languages?.all?.length <= 3) score += 15;  // focused codebase
  return Math.min(score, 100);
}

function buildQualityDetail(analysis: Omit<RepoAnalysis, 'approval'>): string {
  const parts: string[] = [];
  parts.push(analysis.quality.hasTests ? 'tests: yes' : 'tests: NO');
  parts.push(analysis.quality.hasTypes ? 'types: yes' : 'types: NO');
  if (analysis.compatibility.conflictingDeps.length > 0) {
    parts.push(`${analysis.compatibility.conflictingDeps.length} dep conflicts`);
  }
  return parts.join(', ');
}

// -- Language Detection (v2) ------------------------------------------------

function detectLanguages(repoPath: string, pkg: Record<string, unknown>): LanguageInfo {
  const languages: string[] = [];
  let hasTypes = false;

  // TypeScript
  if (findTsconfig(repoPath)) {
    languages.push('TypeScript');
    hasTypes = true;
  }

  // JavaScript (package.json without TS)
  if (fs.existsSync(path.join(repoPath, 'package.json')) && !languages.includes('TypeScript')) {
    languages.push('JavaScript');
  }

  // Python
  const pythonMarkers = ['setup.py', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.cfg'];
  if (pythonMarkers.some(m => fs.existsSync(path.join(repoPath, m)))) {
    languages.push('Python');
    // Check for type hints via py.typed or mypy config
    if (fs.existsSync(path.join(repoPath, 'py.typed'))
      || fs.existsSync(path.join(repoPath, 'mypy.ini'))
      || fs.existsSync(path.join(repoPath, '.mypy.ini'))) {
      hasTypes = true;
    }
  }

  // Go
  if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
    languages.push('Go');
    hasTypes = true;  // Go is statically typed
  }

  // Rust
  if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
    languages.push('Rust');
    hasTypes = true;  // Rust is statically typed
  }

  // Java/Kotlin
  if (fs.existsSync(path.join(repoPath, 'pom.xml'))
    || fs.existsSync(path.join(repoPath, 'build.gradle'))
    || fs.existsSync(path.join(repoPath, 'build.gradle.kts'))) {
    languages.push('Java/Kotlin');
    hasTypes = true;
  }

  // Ruby
  if (fs.existsSync(path.join(repoPath, 'Gemfile'))) {
    languages.push('Ruby');
  }

  // Determine runtime
  let runtime = 'unknown';
  const primary = languages[0] ?? 'unknown';
  if (['TypeScript', 'JavaScript'].includes(primary)) runtime = 'Node.js';
  else if (primary === 'Python') runtime = 'Python';
  else if (primary === 'Go') runtime = 'Go';
  else if (primary === 'Rust') runtime = 'Rust';
  else if (primary === 'Java/Kotlin') runtime = 'JVM';
  else if (primary === 'Ruby') runtime = 'Ruby';

  return {
    primary: primary || 'unknown',
    all: languages,
    runtime,
    hasTypes,
  };
}

// -- License Detection (v2) -------------------------------------------------

function detectLicenseDetail(repoPath: string): LicenseInfo {
  const licenseFiles: string[] = [];
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING'];

  for (const name of candidates) {
    const p = path.join(repoPath, name);
    if (fs.existsSync(p)) licenseFiles.push(name);
  }

  const content = licenseFiles.length > 0
    ? fs.readFileSync(path.join(repoPath, licenseFiles[0]), 'utf-8')
    : '';

  const spdx = detectLicenseSPDX(content);
  const compatible = COMPATIBLE_LICENSES.includes(spdx);

  // EE directory detection
  const eeDirs = detectEEDirs(repoPath);
  const hasEERestrictions = eeDirs.length > 0 || detectProprietaryMarkers(repoPath);

  // Dual license detection
  const dualLicense = content.includes('dual license')
    || content.includes('dual-license')
    || licenseFiles.length > 1
    || (content.includes('Apache') && content.includes('MIT'))
    || hasEERestrictions;

  return {
    spdx,
    compatible,
    hasEERestrictions,
    eeDirs,
    dualLicense,
    licenseFiles,
  };
}

function detectLicenseSPDX(content: string): string {
  if (!content) return 'UNKNOWN';
  // Match MIT grant clause, not just header (fixes split-license bug)
  if (content.includes('MIT License')
    || content.includes('Permission is hereby granted, free of charge')) return 'MIT';
  if (content.includes('Apache License')) return 'Apache-2.0';
  if (content.includes('ISC License')
    || content.includes('Permission to use, copy, modify, and/or distribute')) return 'ISC';
  if (content.includes('BSD 2-Clause')) return 'BSD-2-Clause';
  if (content.includes('BSD 3-Clause')) return 'BSD-3-Clause';
  if (content.includes('GNU General Public License')) return 'GPL';
  if (content.includes('Mozilla Public License')) return 'MPL-2.0';
  if (content.includes('Business Source License') || content.includes('BUSL')) return 'BUSL-1.1';
  if (content.includes('Elastic License')) return 'Elastic-2.0';
  if (content.includes('Server Side Public License') || content.includes('SSPL')) return 'SSPL';
  if (content.includes('GNU Affero')) return 'AGPL-3.0';
  if (content.includes('GNU Lesser')) return 'LGPL';
  return 'UNKNOWN';
}

function detectEEDirs(repoPath: string): string[] {
  const found: string[] = [];
  try {
    const entries = fs.readdirSync(repoPath);
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (EE_DIR_PATTERNS.some(p => lower === p || lower.startsWith(p + '/') || lower.endsWith('/' + p))) {
        const fullPath = path.join(repoPath, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          found.push(entry);
        }
      }
    }
    // Also check nested: packages/ee, apps/ee
    for (const container of ['packages', 'apps', 'libs']) {
      const containerPath = path.join(repoPath, container);
      if (fs.existsSync(containerPath) && fs.statSync(containerPath).isDirectory()) {
        try {
          const nested = fs.readdirSync(containerPath);
          for (const entry of nested) {
            const lower = entry.toLowerCase();
            if (EE_DIR_PATTERNS.some(p => lower === p)) {
              found.push(`${container}/${entry}`);
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return found;
}

function detectProprietaryMarkers(repoPath: string): boolean {
  // Check root LICENSE and any subdirectory LICENSE files for proprietary markers
  const filesToCheck = ['LICENSE', 'LICENSE.md'];
  for (const f of filesToCheck) {
    const p = path.join(repoPath, f);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      if (PROPRIETARY_MARKERS.some(marker => content.includes(marker))) {
        return true;
      }
    }
  }
  // Check EE directory for separate licenses
  for (const eeDir of detectEEDirs(repoPath)) {
    for (const f of filesToCheck) {
      const p = path.join(repoPath, eeDir, f);
      if (fs.existsSync(p)) return true;
    }
  }
  return false;
}

// -- Complexity Metrics (v2) ------------------------------------------------

function measureComplexity(repoPath: string): ComplexityMetrics {
  let totalFiles = 0;
  let totalDirs = 0;
  let estimatedLOC = 0;
  let maxDepth = 0;
  const topLevelDirs: string[] = [];

  // Get top-level directories
  try {
    const entries = fs.readdirSync(repoPath);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'vendor'
        || entry === '__pycache__' || entry === '.git' || entry === 'dist'
        || entry === 'build' || entry === 'target') continue;
      const fullPath = path.join(repoPath, entry);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          topLevelDirs.push(entry);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  // Walk tree (bounded to avoid huge repos killing performance)
  const MAX_FILES_TO_SCAN = 10000;
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'vendor', '__pycache__', 'dist', 'build',
    'target', '.next', '.nuxt', 'coverage', '.tox', '.venv', 'venv',
    'env', '.eggs', '*.egg-info',
  ]);

  function walk(dir: string, depth: number): void {
    if (totalFiles >= MAX_FILES_TO_SCAN) return;
    if (depth > maxDepth) maxDepth = depth;

    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (totalFiles >= MAX_FILES_TO_SCAN) return;
        if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;

        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            totalDirs++;
            walk(fullPath, depth + 1);
          } else if (stat.isFile()) {
            totalFiles++;
            const ext = path.extname(entry).toLowerCase();
            if (CODE_EXTENSIONS.has(ext)) {
              // Rough LOC estimate: file size / 40 bytes per line average
              estimatedLOC += Math.round(stat.size / 40);
            }
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable */ }
  }

  walk(repoPath, 0);

  return { totalFiles, totalDirs, estimatedLOC, maxDepth, topLevelDirs };
}

// -- Monorepo Detection (v2) ------------------------------------------------

function detectMonorepo(repoPath: string, pkg: Record<string, unknown>): MonorepoInfo {
  const packages: string[] = [];
  let workspaceManager: MonorepoInfo['workspaceManager'] = null;

  // npm/yarn workspaces
  if (pkg.workspaces) {
    workspaceManager = 'npm';
    // Try to enumerate actual packages from workspace globs
    const wsConfig = Array.isArray(pkg.workspaces) ? pkg.workspaces
      : (pkg.workspaces as Record<string, unknown>)?.packages;
    if (Array.isArray(wsConfig)) {
      for (const pattern of wsConfig) {
        const dir = String(pattern).replace('/*', '').replace('/**', '');
        const dirPath = path.join(repoPath, dir);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          try {
            const entries = fs.readdirSync(dirPath);
            for (const entry of entries) {
              const pkgJson = path.join(dirPath, entry, 'package.json');
              if (fs.existsSync(pkgJson)) {
                packages.push(`${dir}/${entry}`);
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  // pnpm workspaces
  if (fs.existsSync(path.join(repoPath, 'pnpm-workspace.yaml'))) {
    workspaceManager = 'pnpm';
  }

  // Lerna
  if (fs.existsSync(path.join(repoPath, 'lerna.json'))) {
    workspaceManager = workspaceManager ?? 'lerna';
  }

  // Turborepo
  if (fs.existsSync(path.join(repoPath, 'turbo.json'))) {
    workspaceManager = workspaceManager ?? 'turborepo';
  }

  // Nx
  if (fs.existsSync(path.join(repoPath, 'nx.json'))) {
    workspaceManager = workspaceManager ?? 'nx';
  }

  const isMonorepo = workspaceManager !== null || packages.length > 1;

  return {
    isMonorepo,
    workspaceManager,
    packages,
    packageCount: packages.length,
  };
}

// -- Documentation Health (v2) ----------------------------------------------

function assessDocumentation(repoPath: string): DocumentationHealth {
  const hasReadme = ['README.md', 'README.rst', 'README.txt', 'README']
    .some(f => fs.existsSync(path.join(repoPath, f)));
  const hasContributing = fs.existsSync(path.join(repoPath, 'CONTRIBUTING.md'))
    || fs.existsSync(path.join(repoPath, '.github', 'CONTRIBUTING.md'));
  const hasChangelog = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']
    .some(f => fs.existsSync(path.join(repoPath, f)));
  const hasDocsDir = fs.existsSync(path.join(repoPath, 'docs'))
    || fs.existsSync(path.join(repoPath, 'documentation'));
  const hasSecurityPolicy = fs.existsSync(path.join(repoPath, 'SECURITY.md'))
    || fs.existsSync(path.join(repoPath, '.github', 'SECURITY.md'));
  const hasCodeOfConduct = fs.existsSync(path.join(repoPath, 'CODE_OF_CONDUCT.md'));

  // Score: README worth most, rest are bonuses
  let score = 0;
  if (hasReadme) score += 40;
  if (hasContributing) score += 15;
  if (hasChangelog) score += 15;
  if (hasDocsDir) score += 15;
  if (hasSecurityPolicy) score += 10;
  if (hasCodeOfConduct) score += 5;

  return { hasReadme, hasContributing, hasChangelog, hasDocsDir, hasSecurityPolicy, hasCodeOfConduct, score };
}

// -- CI/CD Detection (v2) ---------------------------------------------------

function detectCI(repoPath: string): CIPresence {
  const platforms: string[] = [];

  // GitHub Actions
  const ghActionsDir = path.join(repoPath, '.github', 'workflows');
  if (fs.existsSync(ghActionsDir)) {
    try {
      const files = fs.readdirSync(ghActionsDir);
      if (files.some(f => f.endsWith('.yml') || f.endsWith('.yaml'))) {
        platforms.push('github-actions');
      }
    } catch { /* skip */ }
  }

  // CircleCI
  if (fs.existsSync(path.join(repoPath, '.circleci', 'config.yml'))) {
    platforms.push('circleci');
  }

  // Travis
  if (fs.existsSync(path.join(repoPath, '.travis.yml'))) {
    platforms.push('travis');
  }

  // GitLab CI
  if (fs.existsSync(path.join(repoPath, '.gitlab-ci.yml'))) {
    platforms.push('gitlab-ci');
  }

  // Jenkins
  if (fs.existsSync(path.join(repoPath, 'Jenkinsfile'))) {
    platforms.push('jenkins');
  }

  // Docker (useful signal even if not CI per se)
  if (fs.existsSync(path.join(repoPath, 'Dockerfile'))
    || fs.existsSync(path.join(repoPath, 'docker-compose.yml'))
    || fs.existsSync(path.join(repoPath, 'docker-compose.yaml'))) {
    platforms.push('docker');
  }

  return { hasCI: platforms.length > 0, platforms };
}

// -- Forkability Assessment (v2) --------------------------------------------

function assessForkability(
  repoPath: string,
  licenseDetail: LicenseInfo,
  complexity: ComplexityMetrics
): ForkabilityAssessment {
  const totalFiles = complexity.totalFiles;
  const proprietaryFiles = countProprietaryFiles(repoPath, licenseDetail.eeDirs);
  const forkableFiles = totalFiles - proprietaryFiles;

  // Determine strategy
  let strategy: ForkabilityAssessment['strategy'];
  let reason: string;
  let score: number;

  if (!licenseDetail.compatible) {
    strategy = 'skip';
    reason = `License (${licenseDetail.spdx}) not compatible with absorption.`;
    score = 0;
  } else if (proprietaryFiles === 0 && totalFiles <= 500) {
    strategy = 'fork-full';
    reason = `Clean license, manageable size (${totalFiles} files). Full fork viable.`;
    score = 95;
  } else if (proprietaryFiles === 0 && totalFiles > 500) {
    strategy = 'extract-selective';
    reason = `Clean license but large (${totalFiles} files). Selective extraction recommended.`;
    score = 75;
  } else if (licenseDetail.hasEERestrictions && forkableFiles > totalFiles * 0.5) {
    strategy = 'extract-selective';
    reason = `EE restrictions on ${proprietaryFiles} files. ${forkableFiles} forkable files available.`;
    score = 60;
  } else if (licenseDetail.hasEERestrictions) {
    strategy = 'self-host';
    reason = `Heavy EE restrictions (${proprietaryFiles}/${totalFiles} proprietary). Self-host as external service.`;
    score = 40;
  } else if (totalFiles > 2000) {
    strategy = 'self-host';
    reason = `Very large repo (${totalFiles} files). Self-host recommended over fork.`;
    score = 50;
  } else {
    strategy = 'pattern-study';
    reason = `Mixed signals. Study patterns and extract specific techniques.`;
    score = 35;
  }

  return { strategy, reason, forkableFiles, proprietaryFiles, forkabilityScore: score };
}

function countProprietaryFiles(repoPath: string, eeDirs: string[]): number {
  let count = 0;
  for (const dir of eeDirs) {
    const dirPath = path.join(repoPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      count += countFilesRecursive(dirPath);
    } catch { /* skip */ }
  }
  return count;
}

function countFilesRecursive(dir: string): number {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) count += countFilesRecursive(fullPath);
        else count++;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count;
}

// -- Test Detection (expanded) ----------------------------------------------

function detectTests(repoPath: string, pkg: Record<string, unknown>): boolean {
  // Directory-based
  const testDirs = ['__tests__', 'test', 'tests', 'spec', 'specs'];
  if (testDirs.some(d => fs.existsSync(path.join(repoPath, d)))) return true;

  // npm test script
  if ((pkg as Record<string, Record<string, string>>).scripts?.test
    && (pkg as Record<string, Record<string, string>>).scripts.test !== 'echo "Error: no test specified" && exit 1') {
    return true;
  }

  // Python test markers
  if (fs.existsSync(path.join(repoPath, 'pytest.ini'))
    || fs.existsSync(path.join(repoPath, 'tox.ini'))
    || fs.existsSync(path.join(repoPath, '.pytest.ini'))) return true;

  // Go test files (any *_test.go in root)
  try {
    const entries = fs.readdirSync(repoPath);
    if (entries.some(e => e.endsWith('_test.go'))) return true;
  } catch { /* skip */ }

  // Rust tests via Cargo
  if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
    try {
      const cargo = fs.readFileSync(path.join(repoPath, 'Cargo.toml'), 'utf-8');
      if (cargo.includes('[dev-dependencies]') || cargo.includes('#[test]')) return true;
    } catch { /* skip */ }
  }

  return false;
}

// -- Shared Helpers ---------------------------------------------------------

/**
 * Check for tsconfig.json at root AND monorepo sub-packages.
 */
function findTsconfig(repoPath: string): boolean {
  if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) return true;

  const monorepoRoots = ['packages', 'apps', 'libs', 'modules', 'services'];
  for (const dir of monorepoRoots) {
    const dirPath = path.join(repoPath, dir);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;
    try {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const tsPath = path.join(dirPath, entry, 'tsconfig.json');
        if (fs.existsSync(tsPath)) return true;
      }
    } catch { /* skip */ }
  }

  return false;
}

function findConflictingDeps(repoDeps: string[]): string[] {
  try {
    const projectRoot = process.env.CLAUDECLAW_PROJECT_ROOT ?? '.';
    const ourPkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
    );
    const ourDeps = {
      ...ourPkg.dependencies,
      ...ourPkg.devDependencies,
    } as Record<string, string>;

    return repoDeps.filter(dep => !!ourDeps[dep]);
  } catch {
    return [];
  }
}

function getLastCommitDate(repoPath: string): string {
  try {
    const { execSync } = require('node:child_process');
    let result = execSync('git log -1 --format=%aI', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!result) {
      result = execSync('git log --all -1 --format=%aI', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    }

    if (!result) {
      const gitHead = path.join(repoPath, '.git', 'HEAD');
      if (fs.existsSync(gitHead)) {
        const stat = fs.statSync(gitHead);
        return stat.mtime.toISOString();
      }
    }

    return result;
  } catch {
    try {
      const gitHead = path.join(repoPath, '.git', 'HEAD');
      if (fs.existsSync(gitHead)) {
        const stat = fs.statSync(gitHead);
        return stat.mtime.toISOString();
      }
    } catch { /* noop */ }
    return '';
  }
}

function isRecentlyMaintained(lastCommitDate: string): boolean {
  if (!lastCommitDate) return false;
  const ninety = 90 * 24 * 60 * 60 * 1000;
  return (Date.now() - new Date(lastCommitDate).getTime()) < ninety;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } {
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  throw new Error(`Cannot parse GitHub URL: ${url}`);
}
