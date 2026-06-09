# ClaudeClaw — Codex Agent Instructions

## Decision-Surfacing Gate

This project enforces a Decision-Surfacing Gate on all governed surfaces.
Before any build that touches controlled files, the gate classifies targets
and produces a Decision Ledger. Governed surfaces require Jason's ruling
before writes proceed.

### Gate Enforcement Rules

1. **GATE policy surfaces** require explicit approval before any write.
   If a write targets a GATE surface without clearance, the build HALTS.

2. **VERIFY policy surfaces** proceed without halt but receive post-write
   confirmation (file existence + size check on disk).

3. **UNCERTAIN targets** (unresolvable paths, opaque bash commands) are
   default-gated per C1 rule. Anything unclassifiable HALTS.

4. **Irreversible actions** (git push, npm publish, database drops, etc.)
   always require explicit clearance.

### Governed Surface Registry

The registry at `src/gate/governed-surface-registry.json` defines all
controlled paths, patterns, and irreversible action classes. The gate
module at `src/gate/` implements classification, interception, and
halt delivery.

### Halt Delivery

When a halt occurs, the Decision Ledger is injected into this file
(AGENTS.md) as a fenced block between gate markers. The build cannot
proceed until Jason rules on the halted surfaces.


## GATE-I1 INTERIM RULE (Active — All Agents Bound)

Until interceptWrite is wired into Edit/Write/MultiEdit tool paths (action-time.ts),
all writes to governed surfaces MUST use Bash-only commands. Direct Edit/Write tool
calls to governed surface files bypass the gate entirely. This rule applies to all
agents and all sessions. Governed surfaces are defined in src/gate/governed-surface-registry.json.
Violation = constitutional breach.

### Bootstrap Rule

The gate interceptor (`armInterceptor()`) is never armed without
Jason's explicit authorization. The gate stays inert until go-live
is approved.


<!-- DIRECTIVES-BLOCK-START (auto-generated from DIRECTIVES-LEDGER.jsonl, do not hand-edit) -->
## Active Directives

| ID | Title | Category | Summary |
|----|-------|----------|---------|
| DIR-001 | Humanization Law | brand-voice | Every external output passes brand-voice check. Em-dashes, AI cliches = block. |
| DIR-002 | Completion Audit Binding | constitutional | Goals close only when audit passes. |
| DIR-003 | Hive Log Everything | constitutional | No silent work. If not in hive, it did not happen. |
| DIR-004 | Priority Discipline | constitutional | Critical and high are rare. Melanie has veto on priority inflation. |
| DIR-005 | Delegation Visible | constitutional | goal delegate agent always. No invisible handoffs. |
| DIR-006 | Zero Revenue Leakage | financial-constant | Every output tracked against billable line in CRM. No unbilled work. |
| DIR-007 | PDF-First Document Delivery | workflow-rule | All viewable documents for Jason or clients produced as PDF by default. Word ... |
| DIR-008 | Cron Never Interrupts Active Work | workflow-rule | Cron notifications acknowledged and scheduled, never interrupt active task. C... |
| DIR-009 | Document Quality Gate | workflow-rule | Before sending any document to Jason or client, producing agent verifies enti... |
| DIR-011 | Per-Action .claude/ Writes | security-gate | All writes to .claude/ directory require per-action authorization. H8 finding... |
| DIR-012 | Registry Writes Via Bash Only | security-gate | All writes to governed surfaces use bash-only commands. Edit/Write tool calls... |
| DIR-013 | Verified Never Self-Reported | evidence-rule | Evidence collection uses verified sources only. No self-reported data accepte... |
| DIR-014 | Session Authority Boundaries | constitutional | All sessions, autonomous or interactive, absent explicit in-session approval ... |
| DIR-015 | MagicLight.ai Time Break Designation | tool-policy | MagicLight.ai designated primary tool for Time Break channel visuals. Lived-f... |
| DIR-016 | Neo Engineering Chamber AGENTS.md Update | workflow-rule | Authorized append of Neo Engineering Chamber governance block to AGENTS.md. C... |

### Retired Directives

| ID | Title | Category | Summary |
|----|-------|----------|---------|
| DIR-010 | GHL Retirement | service-retirement | GoHighLevel RETIRED. Not suspended, not pending reconnect, no resume conditio... |

**Deflection rule:** Any agent encountering a reference to a RETIRED directive must cite the directive ID (e.g., "DIR-010 RETIRED") and park the item. Do not act on retired directives. Do not raise them as gaps or reconnection candidates.

<!-- DIRECTIVES-BLOCK-END -->


## Neo Engineering Chamber

### Context File Reading Order

Every Neo session begins by reading these files in order. If any file is missing, STOP and report to Melanie.

1. `context/project-overview.md` -- product definition, scope, success criteria
2. `context/architecture.md` -- tech stack, boundaries, invariants
3. `context/code-standards.md` -- naming, patterns, banned anti-patterns
4. `context/ai-workflow-rules.md` -- Three-Prompt Workflow, scoping rules
5. `context/progress-tracker.md` -- current phase, completed units, open questions

### Invariants Enforcement

These invariants are hard law. Every build checks them. Every delivery verifies them at close. Violation = build rejected.

1. **MUST:** All cross-agent communication routes through mission-cli. Direct agent-to-agent calls prohibited.
2. **MUST:** Every public-facing output passes human review gate before execution. No autonomous external publishing.
3. **MUST:** Scheduled tasks declare target agent explicitly. Undeclared agent routing to main prohibited.
4. **MUST:** All external API calls handle failure states explicitly. Silent failure not acceptable.
5. **MUST NOT:** No code committed without linked feature spec or issue. Untracked changes prohibited.
6. **MUST:** All writes to governed surfaces cite DIR-XXX pointer or explicit Jason approval. Per DIR-014.

### Three-Prompt Workflow

All engineering work follows exactly three prompts per feature unit. No freeform sessions. No scope drift.

| Prompt | Phase | Owner | Gate |
|--------|-------|-------|------|
| 1 | Spec | Melanie writes, Architectural Engineer reviews | Spec file saved to feature-specs/ before build starts |
| 2 | Build | Neo dispatches sub-agents within spec scope only | Spec is ceiling. No unsolicited improvements. |
| 3 | Close | Code Reviewer + Test/QA dual sign-off | All 4 delivery conditions pass |

**Four delivery conditions (ALL must pass at close):**
1. Unit works end-to-end within spec scope
2. No invariant from architecture.md violated
3. progress-tracker.md updated, unit marked complete
4. `tsc --noEmit` passes (zero TypeScript errors)

### Engineering Chamber Role Roster

| Role | Responsibility | Gate Authority |
|------|---------------|----------------|
| Architectural Engineer | Reviews specs, enforces invariants, approves architecture.md changes | Spec review before build |
| Code Reviewer | Code quality, patterns, standards compliance | Dual sign-off at close |
| Test/QA | Verification, test coverage, delivery condition checks | Dual sign-off at close |
| Security Engineer | Dependency audit, input validation, auth flows | Security review on sensitive units |
| AI/ML Research | Model selection, prompt engineering, evaluation | Advisory on AI-touching units |
| Systems Integration | API contracts, service boundaries, migration safety | Integration review on cross-service units |
| Reliability/Ops | Performance, monitoring, deployment safety | Pre-deploy review |
| Data Engineer | Schema design, migration scripts, data integrity | Data-touching unit review |

### Standing Rules

- Every task gets a spec file BEFORE build starts. No exceptions.
- Spec is ceiling. Neo implements what spec says, nothing more.
- If spec is ambiguous, Neo stops and reports to Melanie. Never guess.
- Correction prompts fix ONE thing. Never batch corrections.
- Close requires DUAL sign-off. Code Reviewer AND Test/QA.
- progress-tracker.md updates after EVERY completed unit.


