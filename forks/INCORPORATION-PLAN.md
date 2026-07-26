# Add-On Fork Incorporation Plan

**Authority:** Jason · **Owner:** Melanie · **Date:** 2026-07-26
**Doctrine:** Absorption 5-step. Scout DONE, Evaluate DONE, Fork DONE. This plan covers Operationalize and Compound.
**Audit:** `docs/power-user-addons-audit.md`

---

## What was forked and why

Five packs pulled into our control surface on 2026-07-26 after audit. Each was cloned, inspected, and confirmed free of hostile install patterns before vendoring.

| Fork | Skills | Size | Primary owner | Revenue vector |
|---|---|---|---|---|
| `gstack` | 59 | 19M | Engineering, project-scoped | Shortens delivery cycle |
| `marketing-skills` | 48 | 4.5M | Melissa, James | Authority track |
| `claude-seo` | 33 | 5.2M | Melissa | Authority track, dormant |
| `financial-services` | 118 | 3.9M | Jackson | Delivery track, margin discipline |
| `claude-for-legal` | 151 | 4.8M | Sean, Melanie | Delivery track, contract risk |

**Total: 409 skills, 37M.** That number is the point of this document. Linking all 409 into every agent's global skills directory would be a serious context regression across a fleet already carrying a 47 KB constitutional `CLAUDE.md`. Scope per agent.

Upstream `.git` directories were stripped so these are owned forks, not tracked clones. gstack was trimmed of its 29M browser test fixture corpus and 9.4M of committed build output. Refresh procedure is at the bottom of this document.

---

## Phase 1: Link and verify (Day 1)

```powershell
powershell -ExecutionPolicy Bypass -File forks\install-addons.ps1 -Tier 2 -DryRun
powershell -ExecutionPolicy Bypass -File forks\install-addons.ps1 -Tier 2
```

Junctions, not copies. A `git pull` on this repo updates the live skills with no reinstall step.

**Verify:** `dir %USERPROFILE%\.claude\skills` shows five new entries. Melanie confirms in hive.

**Do not run Tier 3 yet.** gstack needs bun and a decision (Phase 4).

## Phase 2: Route to owning agents (Day 2 to 3)

Each pack goes into the owning agent's `CLAUDE.md` skills table, not into all six.

| Agent | Add to their skills table | Trigger phrasing |
|---|---|---|
| Melissa (content) | `marketing-skills`: `copywriting`, `content-strategy`, `social`, `ad-creative`, `marketing-psychology` | content pipeline, hooks, post drafting |
| James (comms) | `marketing-skills`: `cold-email`, `prospecting`, `copy-editing` | outreach, DMs, replies |
| Jackson (CRM) | `financial-services`: margin, pricing, forecasting plugins | pipeline analysis, margin floor checks, DSO |
| Sean (ops) | `claude-for-legal`: `commercial-legal`, `corporate-legal` | client contracts, SOW review |
| Melanie | `claude-for-legal` read access, `financial-services` read access | contract sign-off, margin audits |
| Annika (research) | `marketing-skills`: `competitor-profiling`, `competitors` | prospect intel, competitive briefs |

**Rule:** no agent gets a pack it will not use inside seven days. Unused skills are context tax.

## Phase 3: Wire into existing workflows (Day 4 to 7)

### 3a. Content pipeline (Melissa)
Daily post drafting picks up `copywriting` and `social`. Output still passes `humanizer` then `humanizer-collective` before send. The override layer is not optional: upstream humanizer permits em dashes when a writing sample contains them, DIR-001 does not.

### 3b. Margin audit (Jackson, monthly)
`financial-services` plugins feed the monthly margin audit against the 85% floor and the 14-day DSO target. Replaces manual spreadsheet work, not the judgment call.

### 3c. Client contract review (Sean, Melanie)
Every client contract runs through `commercial-legal` before signature. Output is advisory only. It does not replace a lawyer and must never be represented to a client as legal advice.

### 3d. Competitive intelligence (Annika)
`competitor-profiling` folds into the weekly digest. Cross-reference against the Friday Capture goal.

## Phase 4: gstack decision (RESOLVED 2026-07-26)

**Ruling: keep the fork as reference. Do not link it. Tier 3 stays unrun.**

gstack is the one Jason specifically asked for, and the capability he wants from it is real: CEO, designer, engineer and QA review as separate passes. The problem is that the capability cannot be separated from the methodology.

### Finding 1: the ethos is inlined, so there is no clean subset

`ETHOS.md` says its principles "are injected into every workflow skill's preamble automatically." That is not a runtime reference to a file that can simply be left unlinked. It is a build-time inline. Every built `SKILL.md` already carries the text:

```
## Completeness Principle - Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full
coverage (tests, edge cases, error paths) - boil the ocean one lake at a time.
The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter
migrations); flag that as separate scope, never as an excuse for a shortcut.
```

That block is present in `review/SKILL.md`, `qa/SKILL.md`, `design-review/SKILL.md`, `plan-ceo-review/SKILL.md` and the rest. Cherry-picking the four review skills imports it four times over.

### Finding 2: the conflict is on the most load-bearing rule we have

`docs/coding-discipline.md` §3 defines out of scope as: adjacent code that merely sits near your change, style refactors, pre-existing dead code. Its test is "every changed line should serve the stated goal or the causal path to it."

gstack defines out of scope as: genuinely unrelated work only, and explicitly forbids treating anything narrower as a reason to stop.

Those are not different emphases. They are opposite definitions of the same term, and §3 is the rule that keeps six agents from expanding every maintenance ticket into a refactor. gstack's position is coherent on greenfield work where nothing depends on the result yet. It is the wrong default for a running system where most work is maintenance posture on code other agents call.

### Finding 3: the volume

**62,174 lines across 59 `SKILL.md` files.** The entire constitutional `CLAUDE.md` is roughly 900. A single gstack skill, `review`, is 1,852 lines. Linking the review cluster alone adds about 7,500 lines of instruction carrying a competing methodology.

### What was done instead

`skills/plan-review/SKILL.md`. The four-lens structure that Jason wanted, CEO plus design plus engineering plus QA as separate passes with an explicit reconcile step, written to run under `docs/coding-discipline.md` rather than against it. Roughly 150 lines against gstack's 7,500 for the same capability, and it is ours to change.

### When to revisit

Run real gstack if a genuinely greenfield, throwaway project comes up where boil-the-ocean is the correct default and no existing agent depends on the output. Never on ClaudeClaw itself.

```powershell
# Only for an isolated greenfield repo, never fleet-wide:
cd forks\gstack; .\setup     # requires bun, see bun.sh
```

The fork stays in tree because it is good reference material and re-cloning costs a session. Keeping it is free. Linking it is not.

## Phase 5: Compound (Week 3+)

- Reverse brief per pack: what did it actually change about output quality?
- Any pack unused after 14 days gets unlinked. Absorption doctrine step 4: if it is not used by Monday, it is not a capability.
- Log per-pack outcomes to the Ideation Registry.

---

## Blocked

**Caveman (`JuliusBrussee/caveman`).** Not forked, not installed, and it should stay that way.

It rewrites agent replies into clipped caveman-speak. That breaches DIR-001 by construction across six agents whose external output is the product. It also ships `/caveman-compress`, advertised for rewriting `CLAUDE.md`, which here is 47 KB of constitutional doctrine governing the fleet. Its own README reports **0% input token savings**, so it compresses the cheaper half of the bill.

Jason believed this was already installed. A full repo search on 2026-07-26 found zero references. If it is present in `%USERPROFILE%\.claude\skills` on the Windows host it was installed outside the repo and should be removed.

Token cost lever remains `/compact`, `/clear` and tighter delegation scope.

---

## Surface decision: Claude Code, not Claude Desktop (2026-07-26)

Question raised: should these packs live in the Claude Desktop app instead, so Claude can see more of the Windows machine?

**No, and the premise is inverted.** Desktop sees less of the machine, not more.

| | Claude Code (ClaudeClaw today) | Claude Desktop / claude.ai |
|---|---|---|
| Skill storage | Filesystem, `~/.claude/skills/`, plain directories | Zip upload via Settings, Features |
| Where skills run | Locally, real bash, real filesystem | Code-execution **VM sandbox** |
| Machine access | Full, this is how the fleet works today | Sandboxed. Local access only via separately configured MCP servers |
| Sync | Git, one source of truth | **Does not sync across surfaces.** claude.ai, API and Claude Code are separate |

The fleet already has the deeper access. Moving skills to Desktop would trade real machine access for a sandbox.

**The governance problem is worse than the capability one.** Skills do not sync across surfaces. A Desktop copy is a second, divergent installation with no `git pull` path. Critically, `humanizer-collective` would not be there unless separately uploaded, so a Desktop instance drafting client prose has no DIR-001 enforcement at all. That is a constitutional hole, not an inconvenience.

**Where Desktop does win:** ad-hoc, human-in-the-loop document work. Reviewing a specific contract with the PDF open in front of you is Desktop-shaped. A scheduled margin audit is ClaudeClaw-shaped.

**Ruling:** fleet packs stay on Claude Code. If a Desktop surface is wanted for interactive contract review, upload `claude-for-legal` plus `humanizer-collective` together, never the legal pack alone, and treat it as a read-and-advise surface that produces nothing client-facing without a pass back through the fleet gate.

## Finding: em dash density in the new packs (DIR-001 risk)

Scanned on 2026-07-26 after forking.

| Pack | SKILL.md with em dashes | Total occurrences |
|---|---|---|
| `claude-for-legal` | 151 of 151 | 5,834 |
| `financial-services` | 114 of 118 | 1,103 |
| `marketing-skills` | 44 of 48 | 1,097 |
| `claude-seo` | 1 of 33 | 1 |

**9,035 occurrences across the four packs.** They sit in instruction prose, not in client-facing output templates, which is the better of the two possibilities. But loading several thousand em dashes of instruction text into context is a real style prior, and DIR-001 is absolute.

**Decision: strengthen the gate, do not rewrite the corpus.**

Stripping em dashes from 350 forked files was considered and rejected on two grounds. First, coding-discipline §3: the causal path to DIR-001 compliance is the send gate, which already exists. Rewriting upstream prose is adjacent improvement. Second, and decisive, it would make every future upstream refresh diff enormous and unreviewable, defeating R4 and R5 below.

**Mitigation:** `humanizer` then `humanizer-collective` remain mandatory on any prose these packs produce. That was already the rule. This finding raises its priority from routine to load-bearing, because the packs actively push the other way. Any agent linking one of these packs must have `humanizer-collective` linked too. Both installers enforce this by making it Tier 1, so it is always present.

## Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | 409 skills degrade agent context and routing accuracy | 4 | 4 | Phase 2 per-agent scoping. Never link all packs to all agents. |
| R2 | gstack methodology conflicts with `docs/coding-discipline.md` | 4 | 3 | Phase 4 gate. Pick one, do not run both. |
| R3 | Legal pack output mistaken for legal advice | 2 | 5 | Advisory only. Never represented to a client as counsel. |
| R4 | Forks drift from upstream, security fixes missed | 3 | 3 | Quarterly refresh, procedure below. |
| R5 | Upstream repo goes hostile after a future pull | 2 | 5 | Owned forks. Re-audit diff before any refresh lands. |
| R6 | Caveman installed outside the repo, unnoticed | 2 | 4 | Check `%USERPROFILE%\.claude\skills` during Monday audit. |
| R7 | Em dash density in new packs biases output, breaching DIR-001 | 4 | 4 | `humanizer-collective` is Tier 1 in both installers, so it is always linked alongside. Gate is mandatory, not advisory. |
| R8 | Desktop copy of a pack diverges, with no DIR-001 enforcement | 3 | 4 | Fleet packs stay on Claude Code. Any Desktop upload pairs the pack with `humanizer-collective`, and produces nothing client-facing without a pass back through the fleet gate. |

## Refresh procedure (quarterly)

Owned forks, so refresh is deliberate and diffed, never automatic.

```bash
git clone --depth 1 https://github.com/<upstream> /tmp/refresh-<name>
diff -rq forks/<name> /tmp/refresh-<name> --exclude=.git
```

Review the diff before applying. Re-run the audit checks from `docs/power-user-addons-audit.md` section 1. R5 is the reason this is manual.

## Execution authorization

Phases 1 to 3 authorized by Jason on 2026-07-26. Phase 4 needs a separate go after the bun install and the trial build.
