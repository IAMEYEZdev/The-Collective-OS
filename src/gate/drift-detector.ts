/**
 * Drift Detector -- compensating control for Rule 10 (bash-only-permanent).
 *
 * Detects governed-surface files modified without matching gate-log entries.
 * Committed-state baseline (git show HEAD:<path>) compared against working tree.
 * Drift = file differs from committed AND no hive_mind entry explains the change.
 *
 * Standalone module. No side effects. Same pattern as ledger-validator.ts.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────────────

export interface DriftEntry {
  id: string;
  path: string;
  absolute: string;
  policy: string;
  section: string;
}

export interface DriftFinding {
  entry: DriftEntry;
  committedHash: string;
  workingHash: string;
  explanation: 'unlogged' | 'allowlisted' | 'hive-logged';
  detail?: string;
}

export interface AllowlistEntry {
  path: string;
  reason: string;
  agent_id: string;
  created_at: string;      // ISO timestamp
  last_write_at?: string;  // ISO timestamp of last file write (Refinement 2)
}

export interface PathResolutionFinding {
  id: string;
  registeredPath: string;
  reason: string;
}

export interface DriftReport {
  timestamp: string;
  surfaces_checked: number;
  surfaces_skipped: number;
  skipped_reasons: Array<{ id: string; reason: string }>;
  path_resolution_failures: PathResolutionFinding[];
  drift_findings: DriftFinding[];
  clean_surfaces: number;
  is_first_run: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(__dirname, 'governed-surface-registry.json');
const ALLOWLIST_PATH = path.join(PROJECT_ROOT, 'store', 'drift-allowlist.json');
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'artifacts', 'drift-reports');
const ALLOWLIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Helpers ────────────────────────────────────────────────────────

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Normalize path for comparison: lowercase, forward slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Get file content from git committed state (HEAD).
 * Returns null if file is not tracked or git fails.
 */
export function getCommittedContent(absolutePath: string): Buffer | null {
  try {
    // Convert absolute path to repo-relative for git show
    const relPath = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
    const result = execSync(`git show HEAD:"${relPath}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'buffer',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Get file content from working tree.
 * Returns null if file does not exist.
 * Normalizes CRLF -> LF to match git's storage format (avoids false
 * positives on Windows where working tree has CRLF but git stores LF).
 */
export function getWorkingContent(absolutePath: string): Buffer | null {
  try {
    const raw = fs.readFileSync(absolutePath);
    // Normalize CRLF -> LF for text files (git stores LF)
    const str = raw.toString('utf8');
    const normalized = str.replace(/\r\n/g, '\n');
    return Buffer.from(normalized, 'utf8');
  } catch {
    return null;
  }
}

// ── Registry Extraction ────────────────────────────────────────────

interface RegistryData {
  version: string;
  memory_stores: { stores: Array<Record<string, unknown>> };
  verify_surfaces: { surfaces: Array<Record<string, unknown>> };
  governance_surfaces: { surfaces: Array<Record<string, unknown>> };
  runtime_machinery: { surfaces: Array<Record<string, unknown>> };
  shared_config_surfaces: { surfaces: Array<Record<string, unknown>> };
  self_governance: Record<string, unknown>;
}

/**
 * Extract all driftable entries from registry.
 * Filters: must have concrete absolute path, not a directory, not a .db file.
 * @param registryPath - path to registry JSON
 * @param projectRoot - override for PROJECT_ROOT (used in tests)
 */
export function extractDriftableEntries(registryPath?: string, projectRoot?: string): {
  entries: DriftEntry[];
  skipped: Array<{ id: string; reason: string }>;
} {
  const regPath = registryPath || REGISTRY_PATH;
  const raw = fs.readFileSync(regPath, 'utf8');
  const registry: RegistryData = JSON.parse(raw);

  const entries: DriftEntry[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  const sections: Array<{ name: string; items: Array<Record<string, unknown>> }> = [
    { name: 'memory_stores', items: registry.memory_stores.stores },
    { name: 'verify_surfaces', items: registry.verify_surfaces.surfaces },
    { name: 'governance_surfaces', items: registry.governance_surfaces.surfaces },
    { name: 'runtime_machinery', items: registry.runtime_machinery.surfaces },
    { name: 'shared_config_surfaces', items: registry.shared_config_surfaces.surfaces },
  ];

  // Add self_governance as single entry
  const selfGov = registry.self_governance;
  if (selfGov) {
    sections.push({ name: 'self_governance', items: [selfGov] });
  }

  for (const section of sections) {
    for (const item of section.items) {
      const id = (item.id as string) || 'unknown';
      const absolute = item.absolute as string | undefined;
      const entryType = item.type as string | undefined;
      const policy = (item.policy as string) || 'GATE';

      // Skip: no concrete absolute path
      if (!absolute) {
        // Check if it has path_pattern only (not driftable without expansion)
        if (item.path_pattern) {
          skipped.push({ id, reason: 'Pattern-only entry, no concrete absolute path' });
        } else if (item.path) {
          skipped.push({ id, reason: 'Relative path only, no absolute' });
        }
        continue;
      }

      // Skip: directories
      if (entryType === 'directory') {
        skipped.push({ id, reason: 'Directory entry, not a single file' });
        continue;
      }

      // Skip: .db files (binary, WAL-managed, hash unstable)
      if (absolute.endsWith('.db')) {
        skipped.push({ id, reason: '.db file, binary/WAL-managed' });
        continue;
      }

      // Skip: files outside the project repo (e.g. ~/.claude/, ~/.codex/)
      // git show HEAD: cannot resolve paths outside PROJECT_ROOT.
      // These are user-home config, not project-governed via git.
      const effectiveRoot = projectRoot || PROJECT_ROOT;
      const relToProject = path.relative(effectiveRoot, absolute);
      if (relToProject.startsWith('..') || path.isAbsolute(relToProject)) {
        skipped.push({ id, reason: `Outside project repo (${absolute.slice(0, 60)}...)` });
        continue;
      }

      // Skip: structurally unbaselineable files (.gitignored, never committed)
      // These can NEVER have a git baseline -- checking them always yields
      // NOT_IN_GIT, which is permanent structural fact, not drift.
      // Covers: .env, settings.local.json, similar gitignored configs.
      const gitignoredPermanentSkips = ['.env', 'settings.local.json', '.mcp.json'];
      const basename = path.basename(absolute);
      if (gitignoredPermanentSkips.includes(basename)) {
        skipped.push({ id, reason: `Gitignored file (${basename}), structurally unbaselineable` });
        continue;
      }

      entries.push({
        id,
        path: (item.path as string) || '',
        absolute,
        policy,
        section: section.name,
      });
    }
  }

  return { entries, skipped };
}

// ── F3: Path Resolution Self-Test ──────────────────────────────────

/**
 * F3 self-test: verify every driftable entry's absolute path resolves
 * to a real file on disk. Resolution failure = finding, not skip.
 */
export function selfTestPathResolution(entries: DriftEntry[]): PathResolutionFinding[] {
  const failures: PathResolutionFinding[] = [];

  for (const entry of entries) {
    try {
      const stat = fs.statSync(entry.absolute);
      if (!stat.isFile()) {
        failures.push({
          id: entry.id,
          registeredPath: entry.absolute,
          reason: `Path exists but is not a file (${stat.isDirectory() ? 'directory' : 'other'})`,
        });
      }
    } catch {
      // Check if file is PENDING-CREATION (new governed surface not yet created)
      // Still a finding, but with distinct reason
      failures.push({
        id: entry.id,
        registeredPath: entry.absolute,
        reason: 'Path does not exist on disk',
      });
    }
  }

  return failures;
}

// ── Allowlist ──────────────────────────────────────────────────────

/**
 * Load drift allowlist. Returns empty array if file doesn't exist.
 */
export function loadAllowlist(allowlistPath?: string): AllowlistEntry[] {
  const aPath = allowlistPath || ALLOWLIST_PATH;
  try {
    const raw = fs.readFileSync(aPath, 'utf8');
    return JSON.parse(raw) as AllowlistEntry[];
  } catch {
    return [];
  }
}

/**
 * Check if a path has a valid (non-expired) allowlist entry.
 *
 * Refinement 2: Expiry measured from last_write_at if present.
 * If entry expired but file unchanged since allowlist creation,
 * returns 'stale-silent' (no alert). If no entry at all, returns 'missing'.
 */
export function checkAllowlist(
  absolutePath: string,
  allowlist: AllowlistEntry[],
  now?: Date,
): 'active' | 'stale-silent' | 'expired-changed' | 'missing' {
  const normTarget = normalizePath(absolutePath);
  const currentTime = (now || new Date()).getTime();

  const matching = allowlist.filter(e => normalizePath(e.path) === normTarget);

  if (matching.length === 0) {
    return 'missing';
  }

  // Use the most recent entry
  const entry = matching.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];

  // Determine expiry anchor: last_write_at if available, else created_at
  const expiryAnchor = entry.last_write_at
    ? new Date(entry.last_write_at).getTime()
    : new Date(entry.created_at).getTime();

  const age = currentTime - expiryAnchor;

  if (age <= ALLOWLIST_TTL_MS) {
    return 'active';
  }

  // Expired. Check if file changed since allowlist entry creation.
  // If file mtime <= entry creation time, file hasn't been touched since.
  try {
    const stat = fs.statSync(absolutePath);
    const fileModTime = stat.mtimeMs;
    const entryCreation = new Date(entry.created_at).getTime();

    if (fileModTime <= entryCreation) {
      // File unchanged since allowlist was created. Silent expiry.
      return 'stale-silent';
    }
  } catch {
    // File doesn't exist or can't stat. Treat as expired-changed to be safe.
  }

  return 'expired-changed';
}

// ── Hive Mind Correlation ──────────────────────────────────────────

/**
 * Check if hive_mind has a recent entry explaining a write to this path.
 * Searches summary and artifacts columns for path references.
 *
 * @param absolutePath - the governed surface path
 * @param dbPath - path to claudeclaw.db
 * @param hoursBack - how far back to search (default 48h)
 */
export function checkHiveMind(
  absolutePath: string,
  dbPath?: string,
  hoursBack: number = 48,
): { found: boolean; matchingSummary?: string } {
  const db = dbPath || path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

  // Extract filename and relative path for fuzzy matching
  const fileName = path.basename(absolutePath);
  const relPath = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');

  try {
    // Use sqlite3 CLI to query (no native bindings needed)
    const cutoff = Math.floor(Date.now() / 1000) - (hoursBack * 3600);
    const query = `SELECT summary FROM hive_mind WHERE created_at > ${cutoff} AND (summary LIKE '%${fileName}%' OR artifacts LIKE '%${fileName}%' OR summary LIKE '%${relPath}%') ORDER BY created_at DESC LIMIT 1;`;

    const result = execSync(`sqlite3 "${db}" "${query}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (result.length > 0) {
      return { found: true, matchingSummary: result.split('\n')[0] };
    }
    return { found: false };
  } catch {
    // DB not accessible or query failed. Conservative: not found.
    return { found: false };
  }
}

// ── Core Detection ─────────────────────────────────────────────────

/**
 * Detect drift on a single entry.
 * Returns null if no drift (file matches committed state).
 */
export function detectSingleDrift(
  entry: DriftEntry,
  allowlist: AllowlistEntry[],
  dbPath?: string,
): DriftFinding | null {
  const committed = getCommittedContent(entry.absolute);
  const working = getWorkingContent(entry.absolute);

  // File not in git and not on disk: nothing to compare
  if (!committed && !working) return null;

  // File exists on disk but not in git: new file, always drift
  // File in git but not on disk: deleted file, always drift
  const committedHash = committed ? sha256(committed) : 'NOT_IN_GIT';
  const workingHash = working ? sha256(working) : 'DELETED';

  // No drift: hashes match
  if (committedHash === workingHash) return null;

  // Drift detected. Check explanations.

  // 1. Check allowlist
  const allowStatus = checkAllowlist(entry.absolute, allowlist);
  if (allowStatus === 'active') {
    return {
      entry,
      committedHash,
      workingHash,
      explanation: 'allowlisted',
      detail: 'Active allowlist entry covers this change',
    };
  }
  if (allowStatus === 'stale-silent') {
    // Expired but file unchanged since creation. Silent.
    return null;
  }

  // 2. Check hive_mind for logged write
  const hiveCheck = checkHiveMind(entry.absolute, dbPath);
  if (hiveCheck.found) {
    return {
      entry,
      committedHash,
      workingHash,
      explanation: 'hive-logged',
      detail: `Hive entry: ${hiveCheck.matchingSummary?.slice(0, 120)}`,
    };
  }

  // 3. Unlogged drift. This is the red flag.
  return {
    entry,
    committedHash,
    workingHash,
    explanation: 'unlogged',
    detail: 'File differs from committed state with no hive_mind entry or allowlist',
  };
}

// ── Full Scan ──────────────────────────────────────────────────────

export interface DetectOptions {
  registryPath?: string;
  allowlistPath?: string;
  dbPath?: string;
  artifactsDir?: string;
  projectRoot?: string;
}

/**
 * Run full drift detection scan.
 *
 * Steps:
 * 1. Extract driftable entries from registry
 * 2. F3 self-test: verify all paths resolve
 * 3. Compare committed vs working tree hashes
 * 4. Correlate against allowlist and hive_mind
 * 5. Produce report
 */
export function runDriftScan(options: DetectOptions = {}): DriftReport {
  const { entries, skipped } = extractDriftableEntries(options.registryPath, options.projectRoot);

  // F3: path resolution self-test
  const pathFailures = selfTestPathResolution(entries);

  // Filter to entries that actually exist on disk for hash comparison
  const driftableOnDisk = entries.filter(e => {
    const hasFinding = pathFailures.some(f => f.id === e.id);
    if (hasFinding) return false;
    return true;
  });

  // Load allowlist
  const allowlist = loadAllowlist(options.allowlistPath);

  // Detect drift on each entry
  const findings: DriftFinding[] = [];
  for (const entry of driftableOnDisk) {
    const finding = detectSingleDrift(entry, allowlist, options.dbPath);
    if (finding) {
      findings.push(finding);
    }
  }

  const cleanCount = driftableOnDisk.length - findings.length;

  // Check if this is first run (no prior drift report exists)
  const artDir = options.artifactsDir || ARTIFACTS_DIR;
  let isFirstRun = true;
  try {
    const existing = fs.readdirSync(artDir);
    isFirstRun = existing.filter(f => f.startsWith('drift-report-')).length === 0;
  } catch {
    isFirstRun = true;
  }

  const report: DriftReport = {
    timestamp: new Date().toISOString(),
    surfaces_checked: entries.length,
    surfaces_skipped: skipped.length,
    skipped_reasons: skipped,
    path_resolution_failures: pathFailures,
    drift_findings: findings,
    clean_surfaces: cleanCount,
    is_first_run: isFirstRun,
  };

  return report;
}

/**
 * Write drift report to artifacts directory as DELIVERABLE (Refinement 1).
 * First-run report gets special naming for review.
 */
export function writeDriftReport(report: DriftReport, artifactsDir?: string): string {
  const artDir = artifactsDir || ARTIFACTS_DIR;

  // Ensure artifacts directory exists
  fs.mkdirSync(artDir, { recursive: true });

  const dateStr = report.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const prefix = report.is_first_run ? 'FIRST-RUN-drift-report' : 'drift-report';
  const filename = `${prefix}-${dateStr}.json`;
  const fullPath = path.join(artDir, filename);

  fs.writeFileSync(fullPath, JSON.stringify(report, null, 2), 'utf8');

  return fullPath;
}

/**
 * Format drift report as human-readable text.
 */
export function formatReport(report: DriftReport): string {
  const lines: string[] = [];

  lines.push('=== DRIFT DETECTOR REPORT ===');
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`First run: ${report.is_first_run}`);
  lines.push(`Surfaces checked: ${report.surfaces_checked}`);
  lines.push(`Surfaces skipped: ${report.surfaces_skipped}`);
  lines.push(`Clean surfaces: ${report.clean_surfaces}`);
  lines.push(`Drift findings: ${report.drift_findings.length}`);
  lines.push(`Path resolution failures: ${report.path_resolution_failures.length}`);
  lines.push('');

  if (report.path_resolution_failures.length > 0) {
    lines.push('--- F3 PATH RESOLUTION FAILURES ---');
    for (const f of report.path_resolution_failures) {
      lines.push(`  [${f.id}] ${f.registeredPath}`);
      lines.push(`    Reason: ${f.reason}`);
    }
    lines.push('');
  }

  if (report.drift_findings.length > 0) {
    lines.push('--- DRIFT FINDINGS ---');
    for (const f of report.drift_findings) {
      const flag = f.explanation === 'unlogged' ? 'FLAG' : f.explanation.toUpperCase();
      lines.push(`  [${flag}] ${f.entry.id} (${f.entry.policy})`);
      lines.push(`    Path: ${f.entry.absolute}`);
      lines.push(`    Committed: ${f.committedHash.slice(0, 12)}...`);
      lines.push(`    Working:   ${f.workingHash.slice(0, 12)}...`);
      if (f.detail) {
        lines.push(`    Detail: ${f.detail}`);
      }
    }
    lines.push('');
  }

  if (report.drift_findings.length === 0 && report.path_resolution_failures.length === 0) {
    lines.push('All governed surfaces match committed state. No unlogged drift detected.');
  }

  return lines.join('\n');
}
