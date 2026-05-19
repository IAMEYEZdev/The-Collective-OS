/**
 * Borg ARC -- Repository Analysis & Selective Absorption
 *
 * Evaluates GitHub repos for integration into ClaudeClaw.
 * Produces structured analysis: compatibility, quality, risk, absorption plan.
 * Every absorption requires human approval (Melanie recommends, Jason confirms).
 */

import fs from 'node:fs';
import path from 'node:path';

// -- Types ------------------------------------------------------------------

export interface RepoAnalysis {
  repoUrl: string;
  repoName: string;
  analyzedAt: string;

  compatibility: {
    language: string;
    runtime: string;
    dependencies: string[];
    conflictingDeps: string[];
    licenseCompatible: boolean;
    license: string;
  };

  quality: {
    hasTests: boolean;
    hasTypes: boolean;
    lastCommitDate: string;
    stars: number;
    openIssues: number;
    maintainerActive: boolean;
  };

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

// -- Analyzer ---------------------------------------------------------------

const COMPATIBLE_LICENSES = ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause'];

/**
 * Analyze a local clone of a repository for absorption potential.
 * Returns everything except approval (that's filled by the recommendation step).
 */
export function analyzeLocalRepo(
  repoPath: string,
  repoUrl: string
): Omit<RepoAnalysis, 'approval'> {
  const pkgPath = path.join(repoPath, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  const pkg = hasPkg ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) : {};

  const tsconfigExists = fs.existsSync(path.join(repoPath, 'tsconfig.json'));
  const hasTests = fs.existsSync(path.join(repoPath, '__tests__'))
    || fs.existsSync(path.join(repoPath, 'test'))
    || fs.existsSync(path.join(repoPath, 'tests'))
    || (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1');

  const licenseContent = readLicenseFile(repoPath);
  const license = detectLicense(licenseContent);

  const deps = Object.keys(pkg.dependencies ?? {});
  const conflicting = findConflictingDeps(deps);

  const lastCommitDate = getLastCommitDate(repoPath);
  const maintainerActive = isRecentlyMaintained(lastCommitDate);

  return {
    repoUrl,
    repoName: path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    compatibility: {
      language: tsconfigExists ? 'TypeScript' : 'JavaScript',
      runtime: 'Node.js',
      dependencies: deps,
      conflictingDeps: conflicting,
      licenseCompatible: COMPATIBLE_LICENSES.includes(license),
      license,
    },
    quality: {
      hasTests: !!hasTests,
      hasTypes: tsconfigExists,
      lastCommitDate,
      stars: 0,           // filled by GitHub API enrichment
      openIssues: 0,      // filled by GitHub API enrichment
      maintainerActive,
    },
    absorptionPlan: {
      targetFiles: [],
      estimatedLines: 0,
      integrationPoint: '',
      adaptationNeeded: [],
    },
    risk: {
      securityScanRequired: true,  // always true
      breakingChanges: [],
      reversibility: 'easy',
    },
  };
}

/**
 * Enrich analysis with GitHub API data (stars, issues).
 * Requires GITHUB_TOKEN in env or gh CLI auth.
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

/**
 * Generate Melanie's recommendation based on analysis signals.
 */
export function generateRecommendation(
  analysis: Omit<RepoAnalysis, 'approval'>
): RepoAnalysis['approval'] {
  const issues: string[] = [];

  if (!analysis.compatibility.licenseCompatible) {
    issues.push(`incompatible license: ${analysis.compatibility.license}`);
  }
  if (analysis.compatibility.conflictingDeps.length > 0) {
    issues.push(`${analysis.compatibility.conflictingDeps.length} conflicting deps`);
  }
  if (!analysis.quality.hasTests) {
    issues.push('no tests');
  }
  if (!analysis.quality.hasTypes) {
    issues.push('no TypeScript');
  }
  if (!analysis.quality.maintainerActive) {
    issues.push('unmaintained (no commits in 90 days)');
  }

  // Decision logic
  if (!analysis.compatibility.licenseCompatible) {
    return {
      melanieRecommendation: 'skip',
      melanieReason: `License incompatible (${analysis.compatibility.license}). Cannot absorb.`,
      jasonApproved: null,
    };
  }

  if (issues.length >= 3) {
    return {
      melanieRecommendation: 'skip',
      melanieReason: `Too many concerns: ${issues.join(', ')}.`,
      jasonApproved: null,
    };
  }

  if (issues.length >= 1) {
    return {
      melanieRecommendation: 'watch',
      melanieReason: `Some concerns: ${issues.join(', ')}. Worth monitoring.`,
      jasonApproved: null,
    };
  }

  return {
    melanieRecommendation: 'absorb',
    melanieReason: 'Good signals: compatible license, has tests and types, actively maintained.',
    jasonApproved: null,
  };
}

// -- Helpers ----------------------------------------------------------------

function readLicenseFile(repoPath: string): string {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'];
  for (const name of candidates) {
    const p = path.join(repoPath, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  }
  return '';
}

function detectLicense(content: string): string {
  if (!content) return 'UNKNOWN';
  if (content.includes('MIT License')) return 'MIT';
  if (content.includes('Apache License')) return 'Apache-2.0';
  if (content.includes('ISC License')) return 'ISC';
  if (content.includes('BSD 2-Clause')) return 'BSD-2-Clause';
  if (content.includes('BSD 3-Clause')) return 'BSD-3-Clause';
  if (content.includes('GNU General Public License')) return 'GPL';
  if (content.includes('Mozilla Public License')) return 'MPL-2.0';
  return 'UNKNOWN';
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

    return repoDeps.filter(dep => {
      if (!ourDeps[dep]) return false;
      // Flag if same dep exists -- version conflict check would go deeper
      // For now, just flag overlap for manual review
      return true;
    });
  } catch {
    return [];
  }
}

function getLastCommitDate(repoPath: string): string {
  try {
    const { execSync } = require('node:child_process');
    const result = execSync('git log -1 --format=%aI', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.trim();
  } catch {
    return '';
  }
}

function isRecentlyMaintained(lastCommitDate: string): boolean {
  if (!lastCommitDate) return false;
  const ninety = 90 * 24 * 60 * 60 * 1000;
  return (Date.now() - new Date(lastCommitDate).getTime()) < ninety;
}

function parseGitHubUrl(url: string): { owner: string; repo: string } {
  // Handles: https://github.com/owner/repo, git@github.com:owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  throw new Error(`Cannot parse GitHub URL: ${url}`);
}
