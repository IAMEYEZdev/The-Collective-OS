# Feature Spec: 01 Directive Static Block Rollout

## Goal

Complete the DIRECTIVES-001 implementation: enhance the generation script with inject and drift-audit modes, register the ledger as a governed surface, execute artifact dispositions (GHL archive moves + tombstone), and verify all 8 injection targets have current directive blocks matching the ledger.

## Design

All work stays within the existing DIRECTIVES-001 architecture (spec v2.2 at artifacts/specs/DIRECTIVES-001-draft.md). No new abstractions. The generation script at scripts/generate-directive-blocks.mjs is the single tool for block rendering, injection, and drift detection.

### Codebase locations

- Ledger: `artifacts/directives/DIRECTIVES-LEDGER.jsonl` (16 entries, canonical)
- Generation script: `scripts/generate-directive-blocks.mjs`
- Injection targets: `CLAUDE.md`, `agents/comms/CLAUDE.md`, `agents/content/CLAUDE.md`, `agents/custom/CLAUDE.md`, `agents/ops/CLAUDE.md`, `agents/research/CLAUDE.md`, `agents/_template/CLAUDE.md`, `AGENTS.md`
- Governed surface registry: `src/gate/governed-surface-registry.json`

## Implementation

### Step 1: Enhance generation script with --inject mode

Add `--inject <file>` mode to `scripts/generate-directive-blocks.mjs`. This mode:
1. Reads the target file
2. Finds `<!-- DIRECTIVES-BLOCK-START -->` and `<!-- DIRECTIVES-BLOCK-END -->` markers
3. Replaces everything between markers with freshly rendered block from ledger
4. Applies scope filtering: directives with `scope: "content"` only appear in content agent's file; `scope: "neo-chamber"` only in AGENTS.md; `scope: "all-agents"` everywhere
5. Writes the updated file via stdout (bash pipe) per GATE-I1
6. Reports what changed (added/removed/unchanged directives)

Fix existing scope filter bug: DIR-015 (scope: "content") should only appear in agents/content/CLAUDE.md, not in other agent files.

### Step 2: Add --drift mode to generation script

Add `--drift` mode that:
1. For each injection target, reads current block from file
2. Renders expected block from ledger (with scope filtering)
3. Compares. Reports: MATCH, DRIFT (with diff), or MISSING (no block markers found)
4. Exit code 0 if all match, exit code 1 if any drift detected
5. This is the Monday audit tool per DIRECTIVES-001 Section 8

### Step 3: Register ledger as governed surface

Add entry to `src/gate/governed-surface-registry.json`:
```json
{
  "id": "directives-ledger",
  "path": "artifacts/directives/DIRECTIVES-LEDGER.jsonl",
  "policy": "GATE",
  "description": "Canonical directive lifecycle ledger. Append-only.",
  "category": "governance_surfaces"
}
```

### Step 4: Execute GHL artifact dispositions

Per DIRECTIVES-001 Section 10.2 (RULED: zero deletions):

1. Create `retired/GHL-D003/` directory
2. Move `forks/printing-press-library/library/sales-and-crm/gohighlevel/` to `retired/GHL-D003/printing-press-ghl/` with README citing DIR-010
3. Move `fixmybiz-page/ghl-loader.js` to `retired/GHL-D003/` AFTER verifying nothing serves that page (blast-radius check: grep for ghl-loader references)
4. Move `tmp/ghl-audit-workflows.js` to `retired/GHL-D003/`
5. In `src/compile-cli.ts`: replace 'ghl' keyword entry with loud tombstone error citing DIR-010 (not silent removal)
6. RETAIN (no action): `specs/crm-unimatrix-spec.md`, `artifacts/repair-ledgers/SCHED.md`, `scripts/pending-uplift-init.js`

### Step 5: Run drift audit and verify

1. Run `node scripts/generate-directive-blocks.mjs --validate` (ledger integrity)
2. Run `node scripts/generate-directive-blocks.mjs --drift` (all 8 targets match)
3. Run `node scripts/generate-directive-blocks.mjs --status` (16 directives: 15 active, 1 retired)
4. Verify zero GHL references in active code paths (grep, exclude retired/ and specs/)

## Authorization

Governed-surface writes in this spec (CLAUDE.md files, AGENTS.md, governed-surface-registry.json) are authorized under DIR-016 (Neo Engineering Chamber governance block) and DIR-014 (session authority boundaries). Jason approved DIRECTIVES-001 rollout as first Neo dispatch on 2026-06-07.

## Dependencies

- Node.js (already available)
- No new packages needed
- Design spec: `artifacts/specs/DIRECTIVES-001-draft.md` (v2.2, ratified)
- Canonical ledger: `artifacts/directives/DIRECTIVES-LEDGER.jsonl` (16 entries)
- All 8 injection target files must exist (they do)
- GATE-I1 compliance: all file writes via bash commands
- GHL archive source paths (must exist before Step 4):
  - `forks/printing-press-library/library/sales-and-crm/gohighlevel/`
  - `fixmybiz-page/ghl-loader.js`
  - `tmp/ghl-audit-workflows.js`
- GHL archive destination: `retired/GHL-D003/` (created in Step 4.1)

## Verification Checklist

- [ ] `node scripts/generate-directive-blocks.mjs --validate` passes with 0 errors
- [ ] `node scripts/generate-directive-blocks.mjs --drift` returns exit 0 (all 8 targets match ledger)
- [ ] `node scripts/generate-directive-blocks.mjs --inject <file>` works for each target
- [ ] Scope filtering correct: DIR-015 only in content, DIR-016 only in AGENTS.md
- [ ] `src/gate/governed-surface-registry.json` contains directives-ledger entry
- [ ] `retired/GHL-D003/` exists with archived artifacts + README
- [ ] `src/compile-cli.ts` has DIR-010 tombstone error (not silent removal)
- [ ] No new GHL references in active codebase (grep verify, exclude retired/)
- [ ] tsc --noEmit passes with zero errors
- [ ] No invariant from architecture.md violated
