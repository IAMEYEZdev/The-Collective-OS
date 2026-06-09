/**
 * Ledger Validator — enforces ratification-pointer requirement on DIRECTIVES-LEDGER.jsonl
 *
 * Closes fabricated-authority class: any entry with authority containing "Jason"
 * must carry a verifiable ratification_pointer field.
 *
 * Standalone module. No side effects. Does not modify interceptBash or any gate machinery.
 */

// Valid pointer prefixes — structured enough to audit, not cryptographic
const VALID_POINTER_PREFIXES = [
  'hive:',        // hive_mind log ID
  'session:',     // Claude Code session ID
  'telegram:',    // Telegram message timestamp
  'checkpoint:',  // checkpoint ID
  'legacy:',      // pre-ledger entries (honest: no artifact exists)
] as const;

export interface LedgerEntry {
  id: string;
  version: number;
  verb: string;
  date: string;
  authority: string;
  title: string;
  scope: string;
  category: string;
  summary: string;
  injection_targets: string[];
  supersedes: string | null;
  status: string;
  ratification_pointer?: string;
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  entry_id: string;
  error?: string;
}

export interface IntegrityResult {
  valid: boolean;
  entry_count: number;
  errors: ValidationResult[];
}

/**
 * Check if authority field references Jason (case-insensitive).
 */
function authorityReferencesJason(authority: string): boolean {
  if (!authority) return false;
  const lower = authority.toLowerCase();
  return lower.includes('jason');
}

/**
 * Check if a ratification_pointer has valid format.
 * Must start with one of the defined prefixes and have non-empty value after prefix.
 */
function isValidPointer(pointer: string): boolean {
  for (const prefix of VALID_POINTER_PREFIXES) {
    if (pointer.startsWith(prefix) && pointer.length > prefix.length) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a single ledger entry.
 *
 * Rule: if authority references Jason (directly authored OR ratified by),
 * ratification_pointer must be present and valid.
 *
 * Entries with non-Jason authority pass without pointer requirement.
 */
export function validateLedgerEntry(entry: LedgerEntry): ValidationResult {
  if (!entry.id) {
    return { valid: false, entry_id: '(unknown)', error: 'Missing id field' };
  }

  // Check if this entry needs a ratification pointer
  const needsPointer = authorityReferencesJason(entry.authority);

  // Also check ratified_by field (DIR-016 pattern: autonomously minted, then ratified by Jason)
  const ratifiedByJason = typeof entry.ratified_by === 'string'
    && entry.ratified_by.toLowerCase().includes('jason');

  if (!needsPointer && !ratifiedByJason) {
    // Non-Jason authority, no Jason ratification — passes without pointer
    return { valid: true, entry_id: entry.id };
  }

  // Needs pointer — check presence and format
  if (!entry.ratification_pointer) {
    return {
      valid: false,
      entry_id: entry.id,
      error: `authority="${entry.authority}"${ratifiedByJason ? ` + ratified_by="${entry.ratified_by}"` : ''} requires ratification_pointer but field is missing`,
    };
  }

  if (!isValidPointer(entry.ratification_pointer)) {
    return {
      valid: false,
      entry_id: entry.id,
      error: `ratification_pointer "${entry.ratification_pointer}" has invalid format. Must start with: ${VALID_POINTER_PREFIXES.join(', ')}`,
    };
  }

  return { valid: true, entry_id: entry.id };
}

/**
 * Validate entire ledger file.
 * Parses each JSONL line and runs entry validation.
 */
export function validateLedgerFile(fileContent: string): IntegrityResult {
  const lines = fileContent.trim().split('\n').filter(l => l.trim().length > 0);
  const errors: ValidationResult[] = [];

  for (let i = 0; i < lines.length; i++) {
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      errors.push({
        valid: false,
        entry_id: `line-${i + 1}`,
        error: `Invalid JSON on line ${i + 1}`,
      });
      continue;
    }

    const result = validateLedgerEntry(entry);
    if (!result.valid) {
      errors.push(result);
    }
  }

  return {
    valid: errors.length === 0,
    entry_count: lines.length,
    errors,
  };
}

/**
 * Check append-only invariant.
 * Compares old content against new: existing lines must not change, line count must not decrease.
 */
export function checkAppendOnly(oldContent: string, newContent: string): { valid: boolean; error?: string } {
  const oldLines = oldContent.trim().split('\n').filter(l => l.trim().length > 0);
  const newLines = newContent.trim().split('\n').filter(l => l.trim().length > 0);

  if (newLines.length < oldLines.length) {
    return { valid: false, error: `Line count decreased: ${oldLines.length} -> ${newLines.length}. Append-only violation.` };
  }

  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i] !== newLines[i]) {
      return { valid: false, error: `Line ${i + 1} changed. Append-only violation. Old: "${oldLines[i].slice(0, 60)}..." New: "${newLines[i].slice(0, 60)}..."` };
    }
  }

  return { valid: true };
}
