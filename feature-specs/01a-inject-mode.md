# Feature Spec: 01a Inject Mode for Directive Generation Script

## Goal

Add `--inject <file>` mode to `scripts/generate-directive-blocks.mjs` that replaces directive blocks in target files with freshly rendered content from the ledger, with correct scope filtering.

## Design

Single enhancement to existing script. No new files. No new abstractions. Extends the CLI switch statement with one new mode. All output via stdout per GATE-I1.

### Codebase locations

- Script: `scripts/generate-directive-blocks.mjs` (lines 136-154, CLI switch)
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

### Scope filtering rules

Three scopes exist in the ledger:
- `scope: "all-agents"` -- appears in all 8 targets
- `scope: "content"` -- appears ONLY in `agents/content/CLAUDE.md`
- `scope: "neo-chamber"` -- appears ONLY in `AGENTS.md`

Currently `renderBlock()` accepts a scope parameter but the filtering logic is incomplete. DIR-015 (scope: "content") incorrectly appears in all agent files.

## Implementation

### Step 1: Fix scope filtering in renderBlock()

In `scripts/generate-directive-blocks.mjs`, update the `renderBlock()` function (line 50) to filter directives by scope:

1. `scope: "all-agents"` directives always included
2. `scope: "content"` directives included only when target scope is "content"
3. `scope: "neo-chamber"` directives included only when target scope is "neo-chamber"

The scope parameter already exists but is unused in the filter chain. Add `.filter()` before `.sort()` on lines 51-54 and 56-59.

### Step 2: Add --inject mode to CLI switch

Add `case '--inject':` to the switch at line 141. This mode:

1. Takes `args[1]` as target file path
2. **Target whitelist validation**: Validates the path against the 8 approved injection targets listed in "Codebase locations" above. If the path does not match any approved target, print `HALT: <path> is not an approved injection target` to stderr and exit with code 1. No bash output emitted for unknown targets.
3. Reads target file content via `readFileSync`
4. Finds `<!-- DIRECTIVES-BLOCK-START` and `<!-- DIRECTIVES-BLOCK-END -->` markers
5. Determines target scope from file path:
   - Path contains `agents/content/` -> scope "content"
   - Path is `AGENTS.md` -> scope "neo-chamber"
   - All others -> scope "all-agents"
6. Renders fresh block via `renderBlock(directives, determinedScope)`
7. Outputs executable bash commands (cat heredoc with `'EOF'` single-quoted delimiter to prevent variable expansion) to stdout that replace the block region in the file (GATE-I1 compliant: script prints commands, does not write files directly). All file paths in generated commands MUST be double-quoted to handle spaces. Stdout stream MUST be safe to pipe directly to `bash`.
8. Reports what changed (count of directives added/removed/unchanged vs prior block) to **stderr** so stdout remains a clean executable stream

### Step 3: Verify injection on all 8 targets

Run `node scripts/generate-directive-blocks.mjs --inject CLAUDE.md` and pipe to bash for each target. Confirm:
- DIR-015 appears ONLY in `agents/content/CLAUDE.md`
- DIR-016 appears ONLY in `AGENTS.md`
- All other directives appear in all 8 files

## Authorization

Writes to `scripts/generate-directive-blocks.mjs` are authorized: this is an untracked utility script, not a governed surface. Injection target writes (CLAUDE.md files, AGENTS.md) are governed-surface mutations listed in `src/gate/governed-surface-registry.json`. Gate classification: **GATE-I1 compliant** -- the script outputs bash commands to stdout; the human operator (or calling script) pipes to bash. The script itself never calls fs.writeFileSync or equivalent. This satisfies DIR-012 (registry writes via bash only). Authorized under DIRECTIVES-001 (ratified spec v2.2 at `artifacts/specs/DIRECTIVES-001-draft.md`, Section 5), DIR-014 (session authority boundaries), and Jason's explicit approval of DIRECTIVES-001 rollout on 2026-06-07.

## Dependencies

- Node.js (already available)
- `bash` and `sed` available on execution host (output is piped to bash; sed used in generated replacement commands)
- No new npm packages
- Design spec: `artifacts/specs/DIRECTIVES-001-draft.md` (v2.2, ratified)
- Canonical ledger: `artifacts/directives/DIRECTIVES-LEDGER.jsonl` (16 entries)
- All 8 injection target files must exist with `<!-- DIRECTIVES-BLOCK-START` and `<!-- DIRECTIVES-BLOCK-END -->` markers already present

## Verification Checklist

- [ ] `node scripts/generate-directive-blocks.mjs --inject CLAUDE.md` produces valid bash commands
- [ ] `node scripts/generate-directive-blocks.mjs --inject agents/content/CLAUDE.md` output includes DIR-015
- [ ] `node scripts/generate-directive-blocks.mjs --inject agents/comms/CLAUDE.md` output does NOT include DIR-015
- [ ] `node scripts/generate-directive-blocks.mjs --inject AGENTS.md` output includes DIR-016
- [ ] `node scripts/generate-directive-blocks.mjs --inject agents/ops/CLAUDE.md` output does NOT include DIR-016
- [ ] Scope filtering: DIR-015 only in content, DIR-016 only in AGENTS.md, all others everywhere
- [ ] `node scripts/generate-directive-blocks.mjs --validate` still passes with 0 errors
- [ ] `node scripts/generate-directive-blocks.mjs --status` still reports 16 directives
- [ ] tsc --noEmit passes with zero errors
- [ ] No invariant from architecture.md violated
