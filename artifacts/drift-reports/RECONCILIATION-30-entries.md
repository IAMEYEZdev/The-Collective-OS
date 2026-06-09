# Drift Report Reconciliation: 30 Entries vs Engagement Ruling Set

Generated: 2026-06-09T07:55:00Z
Source: FIRST-RUN-drift-report-2026-06-09T05-04-03.json
Method: Each entry cross-referenced against hive_mind action logs (column: action='action')

## Summary

| Category | Count |
|----------|-------|
| TRACED (maps to authorized change) | 22 |
| FINDING (no hive_mind trace) | 8 |
| Total | 30 |

---

## TRACED ENTRIES (22/30)

Each entry below maps to one or more hive_mind action log entries that authorize the change.

| # | ID | Status | Section | Authorizing Hive Entries |
|---|------|--------|---------|--------------------------|
| 1 | goal-sqlite | NEW | memory_stores | hive:920 -- Goal CLI build, DB at ~/.claude/goal/goals.sqlite |
| 2 | root-claude-md | MODIFIED | governance_surfaces | hive:1305 (SIT-001 header rename), hive:1279 (GATE-I1 deployment 8/8), hive:1280 (DIR-010 correction), hive:1421 (Rule 10 restatement), hive:1364 (DIR-015 deployment), hive:1401 (Class B defects) |
| 4 | agent-claude-md-template | MODIFIED | governance_surfaces | hive:1279 (GATE-I1 deployment 8/8), hive:1364 (DIR-015 deployment 8/8) |
| 5 | agent-comms-claude-md | MODIFIED | governance_surfaces | hive:1307 (SIT-001 Writes 8-10 GHL retired), hive:1279 (GATE-I1), hive:1364 (DIR-015) |
| 6 | agent-ops-claude-md | MODIFIED | governance_surfaces | hive:1307 (SIT-001 Writes 8-10 GHL retired), hive:1279 (GATE-I1), hive:1364 (DIR-015) |
| 7 | agent-research-claude-md | MODIFIED | governance_surfaces | hive:1279 (GATE-I1), hive:1364 (DIR-015) |
| 8 | agent-custom-claude-md | MODIFIED | governance_surfaces | hive:1306 (SIT-001 Writes 2-7 Twenty CRM struck), hive:1279 (GATE-I1), hive:1364 (DIR-015) |
| 9 | agent-content-claude-md | MODIFIED | governance_surfaces | hive:1307 (SIT-001 Writes 8-10 GHL retired), hive:1279 (GATE-I1), hive:1364 (DIR-015) |
| 11 | project-agents-md | NEW | governance_surfaces | hive:1279 (GATE-I1 deployment target), hive:1367 (Neo Engineering Chamber governance block) |
| 12 | hook-auto-checkpoint | NEW | governance_surfaces | hive:965 -- "auto-checkpoint-60" shipped as Item 3 (Jun 2 EOD log) |
| 16 | directives-ledger | NEW | governance_surfaces | hive:1326 -- DIRECTIVES-001 rollout, LEDGER.jsonl created with 14 entries |
| 17 | neo-dispatch | MODIFIED | runtime_machinery | hive:1369-1377 -- Neo Engineering dispatches (Specs 01a/01b, worktree fixes, D3-D7) |
| 18 | scheduler-source | MODIFIED | runtime_machinery | hive:1360 (SCAN-F12 repair, escapeHtml), hive:1409 (BOM strip) |
| 19 | brand-voice-gate | NEW | runtime_machinery | hive:971 -- "Brand Voice Gate (L2 fix) built and proved 4 ways. Gate at src/brand-voice-gate.ts" |
| 20 | bot-source | MODIFIED | runtime_machinery | hive:1297 (SIT-001 diffs re-applied), hive:1278 (F9 Telegram HTML escaping), hive:1409 (BOM strip) |
| 21 | orchestrator-source | MODIFIED | runtime_machinery | hive:1388 (GATE-I2 registry edit, orchestrator confirmed governed) |
| 22 | index-source | MODIFIED | runtime_machinery | hive:1390 (V4 ratified, AUTHORIZED-BUT-UNFILED), hive:1409 (BOM strip) |
| 23 | schedule-cli-source | MODIFIED | runtime_machinery | hive:1425 (routing guard build), hive:1423 (revert), hive:1425 (authorized rebuild) |
| 25 | mcp-config | NEW | shared_config_surfaces | hive:370 -- CodeGraph MCP integration, server added to .mcp.json |
| 26 | claude-settings | NEW | shared_config_surfaces | hive:370 -- CodeGraph MCP integration, 8 auto-allow permissions in settings.json |
| 29 | codex-config | NEW | shared_config_surfaces | hive:1368 -- "Codex config updated: agents.max_threads=8 in ~/.codex/config.toml" |
| 30 | self-governance | NEW | self_governance | hive:1388 (GATE-I2 registry creation), hive:1432 (drift-allowlist registration) |

---

## FINDINGS (8/30) -- Untraced Changes

These entries have NO hive_mind action log authorizing their creation or modification.
Classification follows Jason's "line-61 class" pattern: changes that rode along in the 10-day uncommitted window without governance logging.

### Finding F-R1: global-claude-md (#3)
- **Surface:** ~/.claude/CLAUDE.md (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Global CLAUDE.md outside project repo. Contains graphify skill reference. No hive entry for creation or any modification. Lives in user home dir, never committed to any repo.
- **Risk:** LOW -- user-home config, not project-governed. But registry lists it as GATE.
- **Disposition needed:** Confirm authorized (Jason personal config) or reclassify from GATE.

### Finding F-R2: codex-global-agents-md (#10)
- **Surface:** ~/.codex/AGENTS.md (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Codex global AGENTS.md. No hive entry for creation. Likely created during Neo Engineering setup (hive:1365-1368 cover codex config but not this file specifically).
- **Risk:** LOW -- infrastructure config for Codex agent. Not project-governed.
- **Disposition needed:** Log retroactively or reclassify.

### Finding F-R3: hook-context-mode-cache-heal (#13)
- **Surface:** ~/.claude/hooks/context-mode-cache-heal.mjs (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Claude Code hook. No hive entry for creation. Likely installed by context-mode plugin or manually.
- **Risk:** MEDIUM -- hooks execute on every tool call. Unlogged GATE surface.
- **Disposition needed:** Log retroactively with creation context.

### Finding F-R4: hook-pre-compact-snapshot (#14)
- **Surface:** ~/.claude/hooks/pre-compact-snapshot.mjs (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Claude Code hook. No hive entry for creation. Zero matches in hive for "pre-compact".
- **Risk:** MEDIUM -- same as F-R3, hooks are execution-path code.
- **Disposition needed:** Log retroactively with creation context.

### Finding F-R5: hook-session-context-inject (#15)
- **Surface:** ~/.claude/hooks/session-context-inject.mjs (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Claude Code hook. No hive entry for creation. hive:781 mentions src/context-injector module but not this hook file.
- **Risk:** MEDIUM -- same as F-R3/F-R4.
- **Disposition needed:** Log retroactively with creation context.

### Finding F-R6: env-file (#24)
- **Surface:** .env (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Environment file with API keys/secrets. Correctly excluded from git. hive:827 references ".env vars" in GHL purge context, hive:742 references credentials, but no specific governance log for .env creation or modification.
- **Risk:** LOW for governance (secrets file, correctly untracked). But GATE-policy surface with no baseline is structurally blind.
- **Disposition needed:** .env is inherently NOT_IN_GIT by design. Either: (a) add permanent allowlist entry, or (b) reclassify to VERIFY, or (c) accept detector cannot baseline secrets files.

### Finding F-R7: claude-settings-local (#27)
- **Surface:** .claude/settings.local.json (GATE policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Local Claude Code settings override. No hive entry for creation. Likely created during permission/tool configuration.
- **Risk:** LOW -- local dev config. But contains tool permission overrides.
- **Disposition needed:** Log retroactively or reclassify.

### Finding F-R8: claudeignore (#28)
- **Surface:** .claudeignore (VERIFY policy)
- **Status:** NEW (NOT_IN_GIT)
- **Assessment:** Claude Code ignore file. No hive entry for creation. Zero matches in hive.
- **Risk:** LOW -- controls what Claude Code can see. VERIFY policy (not GATE).
- **Disposition needed:** Log retroactively.

---

## Structural Observations

1. **All 8 findings are NEW (NOT_IN_GIT) files.** Zero MODIFIED files lack trace. Every file that existed in committed state and was changed has a hive_mind entry. The governance system works for tracked files.

2. **The untraced pattern is "infrastructure bootstrap":** global configs (~/.claude/, ~/.codex/), hooks, .env, .claudeignore. These were created during system setup phases that predated or ran alongside the governance logging discipline.

3. **Three hooks (F-R3/4/5) are MEDIUM risk** because hooks are execution-path code with GATE policy. The auto-checkpoint hook (entry 12) IS traced (hive:965), proving the logging discipline works when applied.

4. **.env (F-R6) is structurally unbaselineable** via git. The detector correctly flags it but cannot ever show "clean" for a .gitignored file. Needs a policy decision.

---

## Recommended Dispositions (for Jason's ruling)

| Finding | Recommended Action |
|---------|-------------------|
| F-R1 (global-claude-md) | Retroactive log + accept. User-home config, Jason's direct control. |
| F-R2 (codex-agents-md) | Retroactive log. Created during Neo Engineering setup. |
| F-R3 (context-mode-cache-heal hook) | Retroactive log with source attribution. |
| F-R4 (pre-compact-snapshot hook) | Retroactive log with source attribution. |
| F-R5 (session-context-inject hook) | Retroactive log with source attribution. |
| F-R6 (.env) | Policy decision: permanent allowlist or reclassify. Cannot baseline via git. |
| F-R7 (claude-settings-local) | Retroactive log. Local dev config. |
| F-R8 (.claudeignore) | Retroactive log. VERIFY-policy, lowest risk. |

After dispositions applied + retroactive logs filed, the commit-then-re-run sequence should yield 0 drift on all baselineable surfaces and known-allowlisted entries for the structurally unbaselineable ones.
