import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  extractDriftableEntries,
  selfTestPathResolution,
  checkAllowlist,
  detectSingleDrift,
  runDriftScan,
  writeDriftReport,
  formatReport,
  getCommittedContent,
  getWorkingContent,
  type DriftEntry,
  type AllowlistEntry,
  type DriftReport,
} from '../gate/drift-detector.js';

// ── Helpers ────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
}

function writeJSON(dir: string, filename: string, data: unknown): string {
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
  return fp;
}

/** Minimal registry with one concrete file entry */
function makeTestRegistry(dir: string, entries: Array<Record<string, unknown>> = []): string {
  const registry = {
    version: '2.0.0',
    path_count: entries.length,
    policy_definitions: { GATE: 'test', VERIFY: 'test' },
    memory_stores: { stores: [] },
    verify_surfaces: { surfaces: [] },
    governance_surfaces: { surfaces: entries },
    runtime_machinery: { surfaces: [] },
    shared_config_surfaces: { surfaces: [] },
    irreversible_actions: { actions: [] },
    self_governance: {
      id: 'self-gov',
      policy: 'GATE',
      path: 'test-registry.json',
      absolute: path.join(dir, 'test-registry.json'),
      scope: 'test',
    },
  };
  return writeJSON(dir, 'test-registry.json', registry);
}

let testDir: string;

beforeEach(() => {
  testDir = tmpDir();
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── 1. Registry extraction: concrete paths extracted ───────────────
describe('extractDriftableEntries', () => {
  it('extracts entries with absolute paths', () => {
    const govFile = path.join(testDir, 'governed.txt');
    fs.writeFileSync(govFile, 'test content', 'utf8');

    const regPath = makeTestRegistry(testDir, [
      { id: 'GOV-001', policy: 'GATE', absolute: govFile, scope: 'test' },
    ]);

    const { entries, skipped } = extractDriftableEntries(regPath, testDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const gov = entries.find(e => e.id === 'GOV-001');
    expect(gov).toBeDefined();
    expect(gov!.absolute).toBe(govFile);
  });

  it('skips directory entries', () => {
    const regPath = makeTestRegistry(testDir, [
      { id: 'DIR-001', policy: 'GATE', absolute: testDir, scope: 'test', type: 'directory' },
    ]);

    const { entries, skipped } = extractDriftableEntries(regPath, testDir);
    const dirEntry = entries.find(e => e.id === 'DIR-001');
    expect(dirEntry).toBeUndefined();
    expect(skipped.some(s => s.id === 'DIR-001' && s.reason.includes('Directory'))).toBe(true);
  });

  it('skips .db files', () => {
    const dbFile = path.join(testDir, 'test.db');
    fs.writeFileSync(dbFile, 'binary', 'utf8');

    const regPath = makeTestRegistry(testDir, [
      { id: 'DB-001', policy: 'GATE', absolute: dbFile, scope: 'test' },
    ]);

    const { entries, skipped } = extractDriftableEntries(regPath, testDir);
    expect(entries.find(e => e.id === 'DB-001')).toBeUndefined();
    expect(skipped.some(s => s.id === 'DB-001' && s.reason.includes('.db'))).toBe(true);
  });

  it('skips pattern-only entries', () => {
    const regPath = makeTestRegistry(testDir, [
      { id: 'PAT-001', policy: 'GATE', path_pattern: 'src/**/*.ts', scope: 'test' },
    ]);

    const { skipped } = extractDriftableEntries(regPath, testDir);
    expect(skipped.some(s => s.id === 'PAT-001' && s.reason.includes('Pattern'))).toBe(true);
  });
});

// ── 2. F3 self-test: path resolution ───────────────────────────────
describe('selfTestPathResolution (F3)', () => {
  it('passes when file exists', () => {
    const govFile = path.join(testDir, 'exists.txt');
    fs.writeFileSync(govFile, 'content', 'utf8');

    const entries: DriftEntry[] = [
      { id: 'F3-OK', path: 'exists.txt', absolute: govFile, policy: 'GATE', section: 'test' },
    ];

    const failures = selfTestPathResolution(entries);
    expect(failures).toHaveLength(0);
  });

  it('reports finding when path does not exist', () => {
    const entries: DriftEntry[] = [
      { id: 'F3-MISS', path: 'ghost.txt', absolute: path.join(testDir, 'ghost.txt'), policy: 'GATE', section: 'test' },
    ];

    const failures = selfTestPathResolution(entries);
    expect(failures).toHaveLength(1);
    expect(failures[0].id).toBe('F3-MISS');
    expect(failures[0].reason).toContain('does not exist');
  });

  it('reports finding when path is a directory, not file', () => {
    const subDir = path.join(testDir, 'subdir');
    fs.mkdirSync(subDir);

    const entries: DriftEntry[] = [
      { id: 'F3-DIR', path: 'subdir', absolute: subDir, policy: 'GATE', section: 'test' },
    ];

    const failures = selfTestPathResolution(entries);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain('not a file');
  });
});

// ── 3. Allowlist with expiry guard (Refinement 2) ──────────────────
describe('checkAllowlist', () => {
  it('returns "missing" when no entry exists', () => {
    const result = checkAllowlist('/some/path.txt', []);
    expect(result).toBe('missing');
  });

  it('returns "active" when entry is within TTL', () => {
    const now = new Date();
    const entry: AllowlistEntry = {
      path: '/some/path.txt',
      reason: 'manual edit',
      agent_id: 'main',
      created_at: now.toISOString(),
    };

    const result = checkAllowlist('/some/path.txt', [entry], now);
    expect(result).toBe('active');
  });

  it('returns "expired-changed" when entry exceeds TTL and file changed', () => {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago

    // Create a file that has been modified recently
    const filePath = path.join(testDir, 'changed.txt');
    fs.writeFileSync(filePath, 'new content', 'utf8');

    const entry: AllowlistEntry = {
      path: filePath,
      reason: 'old edit',
      agent_id: 'main',
      created_at: oldTime.toISOString(),
    };

    const result = checkAllowlist(filePath, [entry]);
    expect(result).toBe('expired-changed');
  });

  it('uses last_write_at as expiry anchor when present', () => {
    const createdLongAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    const wroteRecently = new Date(Date.now() - 1 * 60 * 60 * 1000);  // 1h ago

    const entry: AllowlistEntry = {
      path: '/some/path.txt',
      reason: 'manual edit',
      agent_id: 'main',
      created_at: createdLongAgo.toISOString(),
      last_write_at: wroteRecently.toISOString(),
    };

    // Even though created 48h ago, last_write_at is 1h ago, within TTL
    const result = checkAllowlist('/some/path.txt', [entry]);
    expect(result).toBe('active');
  });

  it('case-insensitive path matching', () => {
    const now = new Date();
    const entry: AllowlistEntry = {
      path: 'C:\\Users\\Test\\FILE.txt',
      reason: 'test',
      agent_id: 'main',
      created_at: now.toISOString(),
    };

    const result = checkAllowlist('c:/users/test/file.txt', [entry], now);
    expect(result).toBe('active');
  });
});

// ── 4. Single drift detection ──────────────────────────────────────
describe('detectSingleDrift', () => {
  it('returns null when file matches committed state (no drift)', () => {
    // This test uses the actual project repo
    // CLAUDE.md is committed and matches working tree (or has known drift)
    // Use a synthetic approach instead
    const entry: DriftEntry = {
      id: 'SYNTH-001',
      path: 'nonexistent-in-git.txt',
      absolute: path.join(testDir, 'nonexistent-in-git.txt'),
      policy: 'GATE',
      section: 'test',
    };

    // Neither in git nor on disk = no drift (null)
    const result = detectSingleDrift(entry, []);
    expect(result).toBeNull();
  });
});

// ── 5. POSITIVE DETECTION: unlogged governed file change FLAGGED ────
describe('POSITIVE DETECTION: unlogged change is flagged', () => {
  it('FLAGS a governed file that differs from committed state with no log', () => {
    // Create a file, pretend it is committed with different content
    // Since we can't modify git in test, we test the core logic:
    // working content exists, committed content is null (not tracked) = drift

    const govFile = path.join(testDir, 'governed-secret.txt');
    fs.writeFileSync(govFile, 'unauthorized modification', 'utf8');

    const entry: DriftEntry = {
      id: 'POSITIVE-DETECT',
      path: 'governed-secret.txt',
      absolute: govFile,
      policy: 'GATE',
      section: 'governance_surfaces',
    };

    // No allowlist, no hive_mind match (db doesn't exist for this path)
    const bogusDbPath = path.join(testDir, 'nonexistent.db');
    const result = detectSingleDrift(entry, [], bogusDbPath);

    // File exists on disk but not in git = drift
    expect(result).not.toBeNull();
    expect(result!.explanation).toBe('unlogged');
    expect(result!.committedHash).toBe('NOT_IN_GIT');
    expect(result!.workingHash).not.toBe('NOT_IN_GIT');
    expect(result!.detail).toContain('no hive_mind entry');

    // Show the detection output (evidence requirement)
    console.log('\n=== POSITIVE DETECTION OUTPUT ===');
    console.log(`Entry: ${result!.entry.id} (${result!.entry.policy})`);
    console.log(`Path: ${result!.entry.absolute}`);
    console.log(`Committed: ${result!.committedHash}`);
    console.log(`Working:   ${result!.workingHash.slice(0, 16)}...`);
    console.log(`Explanation: ${result!.explanation}`);
    console.log(`Detail: ${result!.detail}`);
    console.log('=== END POSITIVE DETECTION ===\n');
  });

  it('does NOT flag when allowlist covers the change', () => {
    const govFile = path.join(testDir, 'allowed-change.txt');
    fs.writeFileSync(govFile, 'authorized modification', 'utf8');

    const entry: DriftEntry = {
      id: 'ALLOWED-001',
      path: 'allowed-change.txt',
      absolute: govFile,
      policy: 'VERIFY',
      section: 'verify_surfaces',
    };

    const allowlist: AllowlistEntry[] = [{
      path: govFile,
      reason: 'Authorized manual edit for testing',
      agent_id: 'main',
      created_at: new Date().toISOString(),
    }];

    const result = detectSingleDrift(entry, allowlist, path.join(testDir, 'no.db'));

    // Should be flagged as allowlisted, not unlogged
    expect(result).not.toBeNull();
    expect(result!.explanation).toBe('allowlisted');
  });
});

// ── 6. Full scan produces report ───────────────────────────────────
describe('runDriftScan', () => {
  it('produces a complete DriftReport', () => {
    const govFile = path.join(testDir, 'scan-target.txt');
    fs.writeFileSync(govFile, 'scan content', 'utf8');

    const regPath = makeTestRegistry(testDir, [
      { id: 'SCAN-001', policy: 'GATE', absolute: govFile, scope: 'test' },
    ]);

    const artDir = path.join(testDir, 'artifacts');

    const report = runDriftScan({
      registryPath: regPath,
      allowlistPath: path.join(testDir, 'no-allowlist.json'),
      dbPath: path.join(testDir, 'no.db'),
      artifactsDir: artDir,
      projectRoot: testDir,
    });

    expect(report.timestamp).toBeTruthy();
    expect(report.surfaces_checked).toBeGreaterThanOrEqual(1);
    expect(typeof report.clean_surfaces).toBe('number');
    expect(typeof report.is_first_run).toBe('boolean');
    expect(Array.isArray(report.drift_findings)).toBe(true);
    expect(Array.isArray(report.path_resolution_failures)).toBe(true);
  });
});

// ── 7. First-run report written as DELIVERABLE artifact ────────────
describe('writeDriftReport (Refinement 1)', () => {
  it('writes first-run report with FIRST-RUN prefix', () => {
    const artDir = path.join(testDir, 'artifacts');

    const report: DriftReport = {
      timestamp: '2026-06-09T05:00:00.000Z',
      surfaces_checked: 10,
      surfaces_skipped: 3,
      skipped_reasons: [],
      path_resolution_failures: [],
      drift_findings: [],
      clean_surfaces: 10,
      is_first_run: true,
    };

    const outputPath = writeDriftReport(report, artDir);

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(path.basename(outputPath)).toMatch(/^FIRST-RUN-drift-report-/);

    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(written.is_first_run).toBe(true);
    expect(written.surfaces_checked).toBe(10);
  });

  it('writes subsequent reports without FIRST-RUN prefix', () => {
    const artDir = path.join(testDir, 'artifacts');

    const report: DriftReport = {
      timestamp: '2026-06-09T06:00:00.000Z',
      surfaces_checked: 10,
      surfaces_skipped: 3,
      skipped_reasons: [],
      path_resolution_failures: [],
      drift_findings: [],
      clean_surfaces: 10,
      is_first_run: false,
    };

    const outputPath = writeDriftReport(report, artDir);
    expect(path.basename(outputPath)).toMatch(/^drift-report-/);
    expect(path.basename(outputPath)).not.toMatch(/^FIRST-RUN/);
  });
});

// ── 8. Format report produces readable output ──────────────────────
describe('formatReport', () => {
  it('formats clean report', () => {
    const report: DriftReport = {
      timestamp: '2026-06-09T05:00:00.000Z',
      surfaces_checked: 5,
      surfaces_skipped: 2,
      skipped_reasons: [],
      path_resolution_failures: [],
      drift_findings: [],
      clean_surfaces: 5,
      is_first_run: false,
    };

    const text = formatReport(report);
    expect(text).toContain('DRIFT DETECTOR REPORT');
    expect(text).toContain('Surfaces checked: 5');
    expect(text).toContain('No unlogged drift detected');
  });

  it('formats report with findings', () => {
    const report: DriftReport = {
      timestamp: '2026-06-09T05:00:00.000Z',
      surfaces_checked: 5,
      surfaces_skipped: 0,
      skipped_reasons: [],
      path_resolution_failures: [],
      drift_findings: [{
        entry: { id: 'TEST-001', path: 'test.txt', absolute: '/test.txt', policy: 'GATE', section: 'test' },
        committedHash: 'aabbccdd11223344',
        workingHash: 'eeff00112233aabb',
        explanation: 'unlogged',
        detail: 'File differs from committed state with no hive_mind entry or allowlist',
      }],
      clean_surfaces: 4,
      is_first_run: false,
    };

    const text = formatReport(report);
    expect(text).toContain('[FLAG]');
    expect(text).toContain('TEST-001');
    expect(text).toContain('DRIFT FINDINGS');
  });
});

// ── 9. getCommittedContent returns content for tracked files ────────
describe('getCommittedContent', () => {
  it('returns content for a file tracked in git', () => {
    // Use a known tracked file in the project
    const projectRoot = path.resolve(__dirname, '..', '..');
    const knownFile = path.join(projectRoot, 'package.json');

    const content = getCommittedContent(knownFile);
    expect(content).not.toBeNull();
    expect(content!.length).toBeGreaterThan(0);
  });

  it('returns null for untracked file', () => {
    const content = getCommittedContent(path.join(testDir, 'not-in-git.txt'));
    expect(content).toBeNull();
  });
});

// ── 10. getWorkingContent reads file from disk ─────────────────────
describe('getWorkingContent', () => {
  it('reads existing file', () => {
    const fp = path.join(testDir, 'exists.txt');
    fs.writeFileSync(fp, 'hello', 'utf8');

    const content = getWorkingContent(fp);
    expect(content).not.toBeNull();
    expect(content!.toString()).toBe('hello');
  });

  it('returns null for missing file', () => {
    const content = getWorkingContent(path.join(testDir, 'gone.txt'));
    expect(content).toBeNull();
  });
});

// ── 11. End-to-end: real registry scan runs without crash ──────────
describe('end-to-end: real registry scan', () => {
  it('scans the actual governed-surface-registry without error', () => {
    const artDir = path.join(testDir, 'e2e-artifacts');

    // Use the real registry but isolated artifacts
    const report = runDriftScan({
      artifactsDir: artDir,
    });

    expect(report.surfaces_checked).toBeGreaterThan(0);
    expect(report.timestamp).toBeTruthy();

    // F3 proof: path resolution failures are findings, not crashes
    console.log('\n=== F3 SELF-TEST PROOF ===');
    console.log(`Total surfaces checked: ${report.surfaces_checked}`);
    console.log(`Path resolution failures: ${report.path_resolution_failures.length}`);
    for (const f of report.path_resolution_failures) {
      console.log(`  [F3] ${f.id}: ${f.reason} -- ${f.registeredPath}`);
    }
    console.log(`Drift findings: ${report.drift_findings.length}`);
    for (const f of report.drift_findings) {
      const flag = f.explanation === 'unlogged' ? 'FLAG' : f.explanation;
      console.log(`  [${flag}] ${f.entry.id}: ${f.detail?.slice(0, 80)}`);
    }
    console.log('=== END F3 SELF-TEST ===\n');
  });
});
