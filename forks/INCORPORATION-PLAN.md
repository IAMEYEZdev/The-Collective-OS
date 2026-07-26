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

## Phase 4: gstack decision (Week 2)

gstack is the one Jason specifically asked for. It is also the one that needs a decision rather than an install.

**What it is:** 59 skills implementing a full opinionated development methodology, with CEO, designer, engineer and QA role separation.

**Why it is not Tier 2:**
1. It requires `bun`. The source guide names Node 18+ as the prerequisite, which is wrong, and its `setup` script hard-exits without bun.
2. It carries its own `CLAUDE.md`, `ETHOS.md`, `DESIGN.md` and `ARCHITECTURE.md`. These will argue with `docs/coding-discipline.md`, which already defines posture, reversibility ranking and surgical-diff rules.
3. 59 skills fleet-wide is the single largest context addition on this list.

**Recommendation:** install bun, then run gstack project-scoped on one real build. Judge it on that build. If it wins, reconcile its methodology docs against `docs/coding-discipline.md` and pick one. Do not run both.

```powershell
powershell -ExecutionPolicy Bypass -File forks\install-addons.ps1 -Tier 3
cd forks\gstack; .\setup
```

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

## Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | 409 skills degrade agent context and routing accuracy | 4 | 4 | Phase 2 per-agent scoping. Never link all packs to all agents. |
| R2 | gstack methodology conflicts with `docs/coding-discipline.md` | 4 | 3 | Phase 4 gate. Pick one, do not run both. |
| R3 | Legal pack output mistaken for legal advice | 2 | 5 | Advisory only. Never represented to a client as counsel. |
| R4 | Forks drift from upstream, security fixes missed | 3 | 3 | Quarterly refresh, procedure below. |
| R5 | Upstream repo goes hostile after a future pull | 2 | 5 | Owned forks. Re-audit diff before any refresh lands. |
| R6 | Caveman installed outside the repo, unnoticed | 2 | 4 | Check `%USERPROFILE%\.claude\skills` during Monday audit. |

## Refresh procedure (quarterly)

Owned forks, so refresh is deliberate and diffed, never automatic.

```bash
git clone --depth 1 https://github.com/<upstream> /tmp/refresh-<name>
diff -rq forks/<name> /tmp/refresh-<name> --exclude=.git
```

Review the diff before applying. Re-run the audit checks from `docs/power-user-addons-audit.md` section 1. R5 is the reason this is manual.

## Execution authorization

Phases 1 to 3 authorized by Jason on 2026-07-26. Phase 4 needs a separate go after the bun install and the trial build.
