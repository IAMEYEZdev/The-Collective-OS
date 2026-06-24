# Feature Spec: 01d GHL Artifact Retirement and Tombstone

## Goal

Execute GHL artifact dispositions per DIRECTIVES-001 Section 10.2 (RULED: zero deletions): archive GHL artifacts to `retired/GHL-D003/`, add DIR-010 tombstone error in `src/compile-cli.ts`, and verify zero active GHL references remain.

## Design

File moves + one TypeScript code change. No new abstractions. Archive-only pattern: move, do not delete. Tombstone replaces silent keyword with loud error citing DIR-010.

### Codebase locations

- Archive source 1: `forks/printing-press-library/library/sales-and-crm/gohighlevel/`
- Archive source 2: `fixmybiz-page/ghl-loader.js`
- Archive source 3: `tmp/ghl-audit-workflows.js`
- Archive destination: `retired/GHL-D003/` (to be created)
- Tombstone target: `src/compile-cli.ts` (line containing 'ghl' keyword entry)
- RETAIN (no action): `specs/crm-unimatrix-spec.md`, `artifacts/repair-ledgers/SCHED.md`, `scripts/pending-uplift-init.js`

## Implementation

### Step 1: Create archive directory and README

1. Create `retired/GHL-D003/` directory
2. Write `retired/GHL-D003/README.md` citing DIR-010 as authority, listing what was archived and when

### Step 2: Move GHL artifacts to archive

1. Move `forks/printing-press-library/library/sales-and-crm/gohighlevel/` to `retired/GHL-D003/printing-press-ghl/`
2. Blast-radius check for `fixmybiz-page/ghl-loader.js`: grep entire codebase for `ghl-loader` references (exclude `retired/`). If no active references found, move to `retired/GHL-D003/ghl-loader.js`
3. Move `tmp/ghl-audit-workflows.js` to `retired/GHL-D003/ghl-audit-workflows.js`

### Step 3: Add DIR-010 tombstone in compile-cli.ts

In `src/compile-cli.ts`, find the line containing 'ghl' as a pipeline keyword entry. Replace it with a loud tombstone error that:
1. Throws an error (not silent removal) when 'ghl' keyword is encountered
2. Error message cites DIR-010: "GHL RETIRED per DIR-010. No GHL pipeline operations permitted."
3. This ensures any code path hitting the old GHL keyword gets an explicit failure instead of silent skip

### Step 4: Verify zero active GHL references

1. Grep entire codebase for `ghl` (case-insensitive), excluding: `retired/`, `specs/`, `artifacts/repair-ledgers/`, `node_modules/`, `.git/`
2. Only acceptable remaining references: the tombstone in `compile-cli.ts`, CLAUDE.md constitutional retired-services table, and directive ledger DIR-010 entry
3. Any other active reference is a blocker

## Authorization

Write to `src/compile-cli.ts` is a code change (not a governed surface). Archive moves are file operations on untracked directories. Authorized under DIRECTIVES-001 (ratified spec v2.2 at `artifacts/specs/DIRECTIVES-001-draft.md`, Section 10.2), DIR-010 (GHL Retirement directive), DIR-014 (session authority boundaries), and Jason's explicit approval of DIRECTIVES-001 rollout on 2026-06-07.

## Dependencies

- Archive source paths must exist before execution:
  - `forks/printing-press-library/library/sales-and-crm/gohighlevel/` (directory)
  - `fixmybiz-page/ghl-loader.js` (file)
  - `tmp/ghl-audit-workflows.js` (file)
- `src/compile-cli.ts` must contain a 'ghl' keyword entry
- Design spec: `artifacts/specs/DIRECTIVES-001-draft.md` (v2.2, ratified), Section 10.2
- No dependency on specs 01a, 01b, or 01c (can execute independently)

## Verification Checklist

- [ ] `retired/GHL-D003/` exists with README.md
- [ ] `retired/GHL-D003/printing-press-ghl/` contains archived GHL directory
- [ ] `retired/GHL-D003/ghl-loader.js` exists (moved from fixmybiz-page/)
- [ ] `retired/GHL-D003/ghl-audit-workflows.js` exists (moved from tmp/)
- [ ] Original source locations no longer contain GHL artifacts
- [ ] `src/compile-cli.ts` has DIR-010 tombstone error (not silent removal)
- [ ] Grep for active GHL references returns only: tombstone, CLAUDE.md table, ledger entry
- [ ] RETAINED files untouched: `specs/crm-unimatrix-spec.md`, `artifacts/repair-ledgers/SCHED.md`, `scripts/pending-uplift-init.js`
- [ ] tsc --noEmit passes with zero errors
- [ ] No invariant from architecture.md violated
