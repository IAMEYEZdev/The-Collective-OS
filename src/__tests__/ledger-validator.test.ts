import { describe, it, expect } from 'vitest';
import {
  validateLedgerEntry,
  validateLedgerFile,
  checkAppendOnly,
  type LedgerEntry,
} from '../gate/ledger-validator.js';

// ── Helper: minimal valid entry ──────────────────────────────────────
function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'DIR-TEST',
    version: 1,
    verb: 'ISSUE',
    date: '2026-06-09',
    authority: 'Jason',
    title: 'Test Directive',
    scope: 'all-agents',
    category: 'test',
    summary: 'Test summary',
    injection_targets: ['CLAUDE.md'],
    supersedes: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

// ── 1. Pointer enforcement on Jason-authored entries ─────────────────
describe('validateLedgerEntry: Jason authority requires pointer', () => {
  it('FAILS when authority=Jason and no ratification_pointer', () => {
    const result = validateLedgerEntry(makeEntry({ authority: 'Jason' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requires ratification_pointer');
  });

  it('FAILS when authority=jason (case-insensitive)', () => {
    const result = validateLedgerEntry(makeEntry({ authority: 'jason' }));
    expect(result.valid).toBe(false);
  });

  it('PASSES when authority=Jason and valid hive pointer', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'hive:1400',
    }));
    expect(result.valid).toBe(true);
  });

  it('PASSES when authority=Jason and valid session pointer', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'session:abc-123',
    }));
    expect(result.valid).toBe(true);
  });

  it('PASSES when authority=Jason and valid legacy pointer', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'legacy:pre-ledger',
    }));
    expect(result.valid).toBe(true);
  });

  it('PASSES when authority=Jason and valid checkpoint pointer', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'checkpoint:cp-001',
    }));
    expect(result.valid).toBe(true);
  });

  it('PASSES when authority=Jason and valid telegram pointer', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'telegram:1717891200',
    }));
    expect(result.valid).toBe(true);
  });

  it('FAILS when pointer has invalid prefix', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'slack:msg-123',
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid format');
  });

  it('FAILS when pointer is prefix-only (empty value)', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: 'hive:',
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid format');
  });

  it('FAILS when pointer is empty string', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'Jason',
      ratification_pointer: '',
    }));
    expect(result.valid).toBe(false);
  });
});

// ── 2. Non-Jason authority passes without pointer ────────────────────
describe('validateLedgerEntry: non-Jason authority', () => {
  it('PASSES without pointer when authority is non-Jason', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'autonomously-minted-by-neo-pipeline',
    }));
    expect(result.valid).toBe(true);
  });

  it('PASSES without pointer when authority is system', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'system',
    }));
    expect(result.valid).toBe(true);
  });
});

// ── 3. Jason-ratified entries (DIR-016 pattern) ──────────────────────
describe('validateLedgerEntry: ratified_by=Jason requires pointer', () => {
  it('FAILS when ratified_by=Jason but no pointer', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'autonomously-minted-by-neo-pipeline',
      ratified_by: 'Jason',
      ratified_date: '2026-06-08',
    } as Partial<LedgerEntry>));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ratified_by');
  });

  it('PASSES when ratified_by=Jason and pointer present', () => {
    const result = validateLedgerEntry(makeEntry({
      authority: 'autonomously-minted-by-neo-pipeline',
      ratified_by: 'Jason',
      ratified_date: '2026-06-08',
      ratification_pointer: 'hive:1400',
    } as Partial<LedgerEntry>));
    expect(result.valid).toBe(true);
  });
});

// ── 4. Missing id field ──────────────────────────────────────────────
describe('validateLedgerEntry: structural validation', () => {
  it('FAILS when id is missing', () => {
    const entry = makeEntry();
    delete (entry as Record<string, unknown>).id;
    const result = validateLedgerEntry(entry as LedgerEntry);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing id');
  });
});

// ── 5. Full file validation ──────────────────────────────────────────
describe('validateLedgerFile', () => {
  it('validates all entries in JSONL content', () => {
    const content = [
      JSON.stringify(makeEntry({ id: 'DIR-001', ratification_pointer: 'legacy:pre-ledger' })),
      JSON.stringify(makeEntry({ id: 'DIR-002', ratification_pointer: 'hive:1280' })),
    ].join('\n');
    const result = validateLedgerFile(content);
    expect(result.valid).toBe(true);
    expect(result.entry_count).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('catches invalid JSON lines', () => {
    const content = '{"id": "DIR-001"}\n{broken json\n';
    const result = validateLedgerFile(content);
    expect(result.valid).toBe(false);
    expect(result.errors[0].error).toContain('Invalid JSON');
  });

  it('catches entries missing pointers in batch', () => {
    const content = [
      JSON.stringify(makeEntry({ id: 'DIR-001', ratification_pointer: 'legacy:pre-ledger' })),
      JSON.stringify(makeEntry({ id: 'DIR-002' })), // Missing pointer!
    ].join('\n');
    const result = validateLedgerFile(content);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].entry_id).toBe('DIR-002');
  });
});

// ── 6. Append-only invariant ─────────────────────────────────────────
describe('checkAppendOnly', () => {
  const line1 = JSON.stringify(makeEntry({ id: 'DIR-001' }));
  const line2 = JSON.stringify(makeEntry({ id: 'DIR-002' }));
  const line3 = JSON.stringify(makeEntry({ id: 'DIR-003' }));

  it('PASSES when new content appends lines', () => {
    const result = checkAppendOnly(
      [line1, line2].join('\n'),
      [line1, line2, line3].join('\n'),
    );
    expect(result.valid).toBe(true);
  });

  it('PASSES when content is identical', () => {
    const result = checkAppendOnly(
      [line1, line2].join('\n'),
      [line1, line2].join('\n'),
    );
    expect(result.valid).toBe(true);
  });

  it('FAILS when line count decreases', () => {
    const result = checkAppendOnly(
      [line1, line2, line3].join('\n'),
      [line1, line2].join('\n'),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Line count decreased');
  });

  it('FAILS when existing line changes', () => {
    const modifiedLine1 = JSON.stringify(makeEntry({ id: 'DIR-001-MODIFIED' }));
    const result = checkAppendOnly(
      [line1, line2].join('\n'),
      [modifiedLine1, line2, line3].join('\n'),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Line 1 changed');
  });
});
