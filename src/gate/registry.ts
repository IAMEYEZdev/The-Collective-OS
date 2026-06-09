/**
 * Decision-Surfacing Gate — Registry Loader & Classification Engine
 *
 * Loads the governed-surface registry and classifies paths/actions
 * against it. Shared by plan-time and action-time layers.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────────────

export type GatePolicy = 'GATE' | 'VERIFY';

export interface RegistryEntry {
  id: string;
  policy: GatePolicy;
  path?: string;
  path_pattern?: string;
  absolute?: string;
  absolute_pattern?: string;
  scope: string;
  controls?: string;
  verified?: boolean | string; // true | false | "PENDING-CREATION"
  sensitivity?: string;
  severity?: string;
  type?: string;
  note?: string;
}

export interface IrreversibleAction {
  id: string;
  policy: 'GATE';
  description: string;
  tool_patterns: string[];
  severity: string;
}

export interface Registry {
  version: string;
  path_count: number;
  policy_definitions: Record<string, string>;
  memory_stores: { stores: RegistryEntry[] };
  verify_surfaces: { surfaces: RegistryEntry[] };
  governance_surfaces: { surfaces: RegistryEntry[] };
  runtime_machinery: { surfaces: RegistryEntry[] };
  shared_config_surfaces: { surfaces: RegistryEntry[] };
  irreversible_actions: { actions: IrreversibleAction[] };
  self_governance: RegistryEntry;
}

export type Classification =
  | { governed: true; entry: RegistryEntry; policy: GatePolicy; section: string }
  | { governed: false; uncertain?: false }
  | { governed: false; uncertain: true; reason: string };

export interface ActionClassification {
  governed: true;
  action: IrreversibleAction;
  policy: 'GATE';
}

// ── Registry Loader ────────────────────────────────────────────────

const REGISTRY_PATH = path.join(__dirname, 'governed-surface-registry.json');

let cachedRegistry: Registry | null = null;

export function loadRegistry(): Registry {
  if (cachedRegistry) return cachedRegistry;
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  cachedRegistry = JSON.parse(raw) as Registry;
  return cachedRegistry;
}

/** Force reload (used after registry updates). */
export function reloadRegistry(): Registry {
  cachedRegistry = null;
  return loadRegistry();
}

// ── Path Normalization ─────────────────────────────────────────────

/** Normalize path for comparison: lowercase, forward slashes, resolve home dir. */
function normalizePath(p: string): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  let normalized = p
    .replace(/\\/g, '/')
    .toLowerCase();

  // Expand ~ prefix
  if (normalized.startsWith('~/')) {
    normalized = homeDir.replace(/\\/g, '/').toLowerCase() + normalized.slice(1);
  }

  return normalized;
}

/** Check if a path matches a glob-style pattern (simple * matching). */
function matchesPattern(targetPath: string, pattern: string): boolean {
  const normTarget = normalizePath(targetPath);
  const normPattern = normalizePath(pattern);

  // Convert glob to regex: ** matches anything, * matches non-slash
  const regexStr = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars except * and ?
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLESTAR>>>/g, '.*');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normTarget);
}

/** Check if target path matches an entry (exact path or pattern). */
function pathMatchesEntry(targetPath: string, entry: RegistryEntry): boolean {
  const normTarget = normalizePath(targetPath);

  // Check absolute path
  if (entry.absolute && normalizePath(entry.absolute) === normTarget) {
    return true;
  }

  // Check relative path
  if (entry.path && normalizePath(entry.path) === normTarget) {
    return true;
  }

  // Check absolute pattern
  if (entry.absolute_pattern && matchesPattern(targetPath, entry.absolute_pattern)) {
    return true;
  }

  // Check relative pattern
  if (entry.path_pattern && matchesPattern(targetPath, entry.path_pattern)) {
    return true;
  }

  // Directory containment: if entry is a directory, check if target is inside it
  if (entry.type === 'directory') {
    const entryDir = entry.absolute ? normalizePath(entry.absolute) : null;
    if (entryDir && normTarget.startsWith(entryDir + '/')) {
      return true;
    }
  }

  return false;
}

// ── Classification ─────────────────────────────────────────────────

/** All entries from the registry, flattened with their section name. */
function allEntries(registry: Registry): Array<{ entry: RegistryEntry; section: string }> {
  const entries: Array<{ entry: RegistryEntry; section: string }> = [];

  for (const store of registry.memory_stores.stores) {
    entries.push({ entry: store, section: 'memory_stores' });
  }
  for (const surface of registry.verify_surfaces.surfaces) {
    entries.push({ entry: surface, section: 'verify_surfaces' });
  }
  for (const surface of registry.governance_surfaces.surfaces) {
    entries.push({ entry: surface, section: 'governance_surfaces' });
  }
  for (const surface of registry.runtime_machinery.surfaces) {
    entries.push({ entry: surface, section: 'runtime_machinery' });
  }
  for (const surface of registry.shared_config_surfaces.surfaces) {
    entries.push({ entry: surface, section: 'shared_config_surfaces' });
  }
  // Self-governance
  entries.push({ entry: registry.self_governance as RegistryEntry, section: 'self_governance' });

  return entries;
}

// ── Path Classifiability ──────────────────────────────────────────

/** Unresolvable shell/env patterns that make a path unclassifiable. */
const UNCLASSIFIABLE_PATH_PATTERNS = [
  /\$\{[^}]+\}/,       // ${VAR} shell expansion
  /\$[A-Za-z_]\w*/,    // $VAR shell variable (but not $& etc.)
  /%[A-Za-z_]+%/,      // %VAR% Windows env var
  /`[^`]+`/,           // `cmd` backtick subshell
  /\$\([^)]+\)/,       // $(cmd) subshell expansion
];

/**
 * Check if a path can be confidently classified.
 * Returns null if classifiable, or a reason string if not.
 */
export function isPathUnclassifiable(targetPath: string): string | null {
  if (!targetPath || targetPath.trim() === '') {
    return 'Empty path: no target to classify.';
  }

  for (const pattern of UNCLASSIFIABLE_PATH_PATTERNS) {
    if (pattern.test(targetPath)) {
      return `Path contains unresolvable expansion: ${targetPath}`;
    }
  }

  return null;
}

/**
 * Classify a file path against the registry.
 * Returns governed=true with the matching entry, governed=false for
 * known-ungoverned paths, or governed=false+uncertain=true when the
 * path cannot be confidently classified (C1 default-gated rule).
 */
export function classifyPath(targetPath: string): Classification {
  // Check classifiability first: unresolvable paths = UNCERTAIN
  const unclassifiableReason = isPathUnclassifiable(targetPath);
  if (unclassifiableReason) {
    return { governed: false, uncertain: true, reason: unclassifiableReason };
  }

  const registry = loadRegistry();

  for (const { entry, section } of allEntries(registry)) {
    if (pathMatchesEntry(targetPath, entry)) {
      return {
        governed: true,
        entry,
        policy: entry.policy as GatePolicy,
        section,
      };
    }
  }

  return { governed: false };
}

/**
 * Classify a tool command against irreversible actions.
 * Returns the matching action if found.
 */
export function classifyAction(command: string): ActionClassification | null {
  const registry = loadRegistry();
  const cmdLower = command.toLowerCase();

  for (const action of registry.irreversible_actions.actions) {
    for (const pattern of action.tool_patterns) {
      if (cmdLower.includes(pattern.toLowerCase())) {
        return {
          governed: true,
          action,
          policy: 'GATE',
        };
      }
    }
  }

  return null;
}

/** Write-capable operators/commands that indicate mutation even when targets can't be extracted. */
const WRITE_CAPABLE_PATTERNS = [
  />{1,2}/,              // redirect
  /\btee\b/,             // tee writes to files
  /\bmv\b/,              // move
  /\bcp\b/,              // copy
  /\binstall\b/,         // install
  /\bsed\s+-i/,          // in-place sed
  /\bdd\b/,              // dd
  /\bcurl\s+.*-o\b/,     // curl output
  /\bwget\b/,            // wget
  /\bchmod\b/,           // permission change
  /\bchown\b/,           // ownership change
  /\bmkdir\b/,           // directory creation
  /\btouch\b/,           // file creation
];

/** Patterns that make a bash command's targets unextractable. */
const OPAQUE_COMMAND_PATTERNS = [
  /\beval\b/,            // eval executes arbitrary strings
  /\bsource\b/,          // source runs scripts
  /\bexec\b/,            // exec replaces process
  /\$\([^)]*>[^)]*\)/,   // subshell containing redirects
  /`[^`]*>[^`]*`/,       // backtick subshell containing redirects
  /\|\s*\bxargs\b/,      // xargs can write
  /\bfor\b.*\bdo\b/,     // loop constructs
  /\bwhile\b.*\bdo\b/,   // loop constructs
];

export interface ExtractResult {
  targets: string[];
  uncertain: boolean;
  uncertainReason?: string;
}

/**
 * Extract target paths from a Bash command.
 * Returns targets found plus an uncertainty flag when the command
 * contains write-capable operators but targets can't be extracted
 * (C1 default-gated: unclassifiable = HALT).
 */
export function extractTargetsFromCommand(command: string): string[] {
  return extractTargetsWithUncertainty(command).targets;
}

/**
 * Extract targets with uncertainty signal.
 * Used by action-time interceptor to detect opaque/compound commands.
 */
export function extractTargetsWithUncertainty(command: string): ExtractResult {
  const targets: string[] = [];

  // File write redirects: > file, >> file
  const redirects = command.match(/>{1,2}\s*"?([^"&|;\s]+)"?/g);
  if (redirects) {
    for (const r of redirects) {
      const file = r.replace(/>{1,2}\s*"?/, '').replace(/"$/, '');
      if (file) targets.push(file);
    }
  }

  // git push targets
  const gitPush = command.match(/git\s+push\s+(\S+)\s+(\S+)/);
  if (gitPush) {
    targets.push(`git-push:${gitPush[1]}/${gitPush[2]}`);
  }

  // rm / del targets
  const rmMatch = command.match(/(?:rm\s+-rf?|del\s+\/s)\s+"?([^"&|;\s]+)"?/);
  if (rmMatch) {
    targets.push(rmMatch[1]);
  }

  // Uncertainty check: opaque constructs are ALWAYS flagged, even when some
  // targets were extracted. A command like "> safe.log && eval $DANGEROUS"
  // extracts safe.log but the eval portion is invisible to the gate.
  const isOpaque = OPAQUE_COMMAND_PATTERNS.some(p => p.test(command));
  if (isOpaque) {
    return {
      targets,
      uncertain: true,
      uncertainReason: `Opaque command construct (eval/exec/loop/subshell) detected. Extracted targets may be incomplete. Command: ${command}`,
    };
  }

  // No-target case: write-capable operators with nothing extracted
  if (targets.length === 0) {
    const hasWriteCapable = WRITE_CAPABLE_PATTERNS.some(p => p.test(command));
    if (hasWriteCapable) {
      return {
        targets,
        uncertain: true,
        uncertainReason: `Cannot extract targets: write-capable operator with unextractable target. Command: ${command}`,
      };
    }
  }

  // Also check if any extracted target is itself unclassifiable
  for (const t of targets) {
    const unclassifiable = isPathUnclassifiable(t);
    if (unclassifiable) {
      return {
        targets,
        uncertain: true,
        uncertainReason: `Extracted target is unclassifiable: ${unclassifiable}`,
      };
    }
  }

  return { targets, uncertain: false };
}
