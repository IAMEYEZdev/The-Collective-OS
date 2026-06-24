# Feature Spec: 01c Register Directive Ledger as Governed Surface

## Goal

Add the directive ledger (`artifacts/directives/DIRECTIVES-LEDGER.jsonl`) to the governed-surface registry so GATE policy enforcement applies to all ledger mutations.

## Design

Single JSON entry addition to existing registry file. No code changes. No new files.

### Codebase locations

- Registry: `src/gate/governed-surface-registry.json`
- Ledger being registered: `artifacts/directives/DIRECTIVES-LEDGER.jsonl`

## Implementation

### Step 1: Add entry to governed-surface registry

Add the following entry to `src/gate/governed-surface-registry.json`:

```json
{
  "id": "directives-ledger",
  "path": "artifacts/directives/DIRECTIVES-LEDGER.jsonl",
  "policy": "GATE",
  "description": "Canonical directive lifecycle ledger. Append-only.",
  "category": "governance_surfaces"
}
```

This entry must match the existing registry schema exactly. Verify against adjacent entries for field naming and structure.

## Authorization

Write to `src/gate/governed-surface-registry.json` is a governed-surface mutation. Authorized under DIRECTIVES-001 (ratified spec v2.2 at `artifacts/specs/DIRECTIVES-001-draft.md`, Section 7), DIR-014 (session authority boundaries), and Jason's explicit approval of DIRECTIVES-001 rollout on 2026-06-07. Write MUST use bash-only commands per GATE-I1 (DIR-012).

## Dependencies

- `src/gate/governed-surface-registry.json` must exist and be valid JSON
- Design spec: `artifacts/specs/DIRECTIVES-001-draft.md` (v2.2, ratified), Section 7
- GATE-I1 compliance: write via bash command only

## Verification Checklist

- [ ] `src/gate/governed-surface-registry.json` contains entry with `"id": "directives-ledger"`
- [ ] Entry has all 5 fields: id, path, policy, description, category
- [ ] `description` field is exactly: "Canonical directive lifecycle ledger. Append-only."
- [ ] `category` field is exactly: "governance_surfaces"
- [ ] Registry file is valid JSON after addition (parse test)
- [ ] tsc --noEmit passes with zero errors
- [ ] No invariant from architecture.md violated
