# Feature Spec: 01b Drift Audit Mode for Directive Generation Script

## Goal

Add `--drift` mode to `scripts/generate-directive-blocks.mjs` that compares current directive blocks in all 8 injection targets against the canonical ledger and reports MATCH, DRIFT, or MISSING per target.

## Design

Single enhancement to existing script. No new files. No new abstractions. Extends the CLI switch with one new mode. Read-only: does not modify any target files. Exit code signals result.

### Codebase locations

- Script: `scripts/generate-directive-blocks.mjs`
- Ledger: `artifacts/directives/DIRECTIVES-LEDGER.jsonl` (16 entries, canonical)
- Injection targets (8 files):
  - `CLAUDE.md`
  - `agents/comms/CLAUDE.md`
  - `agents/content/CLAUDE.md`
  - `agents/custom/CLAUDE.md`
  - `agents/ops/CLAUDE.md`
  - `agents/research/CLAUDE.md`
  - `agents/_template/CLAUDE.md`
  - `AGENTS.md`

## Implementation

### Step 1: Define target list constant

Add a `INJECTION_TARGETS` array constant near the top of the script (after line 23) listing all 8 target file paths with their expected scopes:

```javascript
const INJECTION_TARGETS = [
  { path: 'CLAUDE.md', scope: 'all-agents' },
  { path: 'agents/comms/CLAUDE.md', scope: 'all-agents' },
  { path: 'agents/content/CLAUDE.md', scope: 'content' },
  { path: 'agents/custom/CLAUDE.md', scope: 'all-agents' },
  { path: 'agents/ops/CLAUDE.md', scope: 'all-agents' },
  { path: 'agents/research/CLAUDE.md', scope: 'all-agents' },
  { path: 'agents/_template/CLAUDE.md', scope: 'all-agents' },
  { path: 'AGENTS.md', scope: 'neo-chamber' },
];
```

### Step 2: Add --drift mode to CLI switch

Add `case '--drift':` to the switch statement. This mode:

1. Iterates all 8 targets in `INJECTION_TARGETS`
2. For each target:
   a. Reads file content
   b. Extracts current block between `<!-- DIRECTIVES-BLOCK-START` and `<!-- DIRECTIVES-BLOCK-END -->` markers
   c. Renders expected block via `renderBlock(directives, target.scope)`
   d. Compares extracted vs expected (trimmed string comparison)
   e. Reports: `MATCH: <path>`, `DRIFT: <path>` (with line-level diff), or `MISSING: <path>` (no markers found)
3. Summary line: `N/8 targets match ledger`
4. Exit code 0 if all 8 match, exit code 1 if any drift or missing detected
5. This is the Monday audit tool per DIRECTIVES-001 Section 8

**Depends on**: Spec 01a (inject mode) must land first, because drift mode requires the same scope filtering logic in `renderBlock()`. If 01a has not been implemented, drift comparison will be incorrect for content and neo-chamber scoped directives.

## Authorization

No governed-surface writes in this spec. Script modification only (untracked utility). Drift mode is read-only.

## Dependencies

- Node.js (already available)
- No new packages
- Design spec: `artifacts/specs/DIRECTIVES-001-draft.md` (v2.2, ratified), Section 8 (drift audit)
- Canonical ledger: `artifacts/directives/DIRECTIVES-LEDGER.jsonl` (16 entries)
- Spec 01a must be implemented first (scope filtering fix in renderBlock)
- All 8 injection target files must exist with directive block markers

## Verification Checklist

- [ ] `node scripts/generate-directive-blocks.mjs --drift` runs without error
- [ ] When all targets match ledger, exit code is 0
- [ ] When a target has been manually altered, exit code is 1 and DRIFT reported with diff
- [ ] When a target is missing markers, MISSING reported
- [ ] Summary reports correct count (e.g., "8/8 targets match ledger")
- [ ] `node scripts/generate-directive-blocks.mjs --validate` still passes
- [ ] `node scripts/generate-directive-blocks.mjs --status` still reports 16 directives
- [ ] tsc --noEmit passes with zero errors
- [ ] No invariant from architecture.md violated
