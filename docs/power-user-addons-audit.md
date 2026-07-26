# Power-User Add-On Audit

**Auditor:** Melanie · **Date:** 2026-07-26 · **Source:** "The 24 Things To Install Into Claude" (skool.com/viral-ads)
**Verdict:** Substantially legitimate. Padded count, one install-blocking omission, one item that is a constitutional breach.

---

## 1. Verification method

The guide names ten GitHub repositories. All ten were cloned and inspected directly, not taken on trust.

| Check | Method | Result |
|---|---|---|
| Repo exists | `git ls-remote` on all 10 | 10 / 10 exist |
| Actively maintained | `git log -1` on fresh clones | 10 / 10 pushed within the last 3 weeks |
| Malicious install patterns | grep for `curl \| sh`, `wget \| sh` | 0 real hits (all matches were docs, Dockerfiles, or test fixtures) |
| npm lifecycle hooks | parsed `package.json` scripts | 3 have `prepare`/`postinstall`, all benign and expected |
| Install commands valid | inspected `.claude-plugin/marketplace.json`, ran `npx skills --help` | Commands work as written |

**Star counts could not be independently verified.** The session proxy blocks `api.github.com` and raw `github.com` HTML. One fetch put `obra/superpowers` near the claimed figure. Treat the numbers as unconfirmed. They are not decision-relevant anyway, and the guide's own advice to judge tools by popularity is the weakest thing in it.

**Nothing in the ten repositories looked hostile.** That is the headline. This is a real list, not a slop list.

---

## 2. The count is padded

Twenty-four is a marketing number. The actual install count is closer to thirteen.

| Guide items | Reality |
|---|---|
| Claude Skills, Frontend Design, Skill Creator, MCP Builder | One install. The latter three are directories inside `anthropics/skills`. |
| Marketing Skills, Social Media Skills | One repo. `social` is a real skill name inside it, so the `--skill social` command is valid, but it is not a separate add-on. |
| Financial Services, Claude for Legal | **Correction, see section 2a.** These are real installable repos. The first version of this audit called them sales pages. That was wrong. |
| Kondo | Not an install. The guide admits this: it is `/compact` and `/clear`. |
| Slack, Notion, Zapier, Granola, Perplexity, Higgsfield | Not installs. Six clicks in Settings, Connectors. |

Real terminal or plugin installs: **15**.

---

## 2a. Correction: Financial Services and Legal are real installs

The first version of this audit stated that Claude for Financial Services and Claude for Legal were "Anthropic industry pages, nothing to add." That was wrong, and it was wrong in the direction that would have cost capability.

Both are real, public, installable GitHub repositories:

| Repo | Skills | Size | Contents |
|---|---|---|---|
| `anthropics/financial-services` | 118 | 3.9M | `plugins/` with agent, vertical and partner-built plugin sets |
| `anthropics/claude-for-legal` | 151 | 4.8M | `commercial-legal`, `corporate-legal`, `ip-legal`, `litigation-legal`, `employment-legal`, `ai-governance-legal` and more |

Both cloned and inspected on 2026-07-26. Both are now forked into `forks/`.

The error came from treating the guide's own vague description ("It is an official industry solution, not a random add-on", with a bare `claude.com` link and no repo path) as evidence that nothing was installable. The guide gave no install command for these two, which is a gap in the guide, but the absence of a command is not evidence of the absence of a repo. Verifying the other ten by cloning and these two by reading the guide was an inconsistent standard.

**Correcting the guide's error count:** this is a genuine omission in the source material. Every other item on the list ships an install command. These two do not, and they are among the highest-value items on it for a consultancy that reviews client contracts and audits margin.

---

## 3. The one install-blocking omission

**gstack requires `bun`, not Node.** The guide's "Common mistakes" section says the terminal commands need Node.js 18+ and lists nodejs.org as the fix. That is wrong for gstack. Its `setup` script references bun 47 times and hard-exits on line 6 if bun is absent:

```
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but not installed." >&2
```

Anyone following the guide's "Day 4: Install gstack" step on a Node-only machine hits a wall. Install bun first.

Two smaller notes, both of which the guide gets right and are worth keeping: `hyperframes` genuinely needs `GIT_LFS_SKIP_SMUDGE=1` (the clone is 172 MB), and the `npx skills` CLI genuinely supports the `--skill` flag as documented.

---

## 4. Install status, verified against the repo

Evidence is repo-side. The Windows host's `~/.claude/skills/` is not visible from an audit container, so "installed" below means the fleet has it wired, proven by references in tracked files.

**Confirmed installed. Do not reinstall.**

| Item | Evidence |
|---|---|
| **Humanizer** | Listed in four agent `CLAUDE.md` files as a global skill, and gated into workflow: "Every message drafted via `message-crafter.ts` must pass through `humanizer` skill before send." |
| **Superpowers** | `docs/superpowers/plans/2026-05-29-claw-code-integration.md` invokes `superpowers:subagent-driven-development` as a required sub-skill. |
| **Codex CLI** | 25 tracked files reference it. Load-bearing in the Neo architecture: "Codex CLI + oh-my-codex substrate", `neo-dispatch.mjs` spawns oh-my-codex leader sessions. |
| **Agent Browser** | In Melanie's skills table in `CLAUDE.md` and in `scripts/setup.ts`. |
| Higgsfield | Live MCP server this session. |
| Slack, Gmail, Google Calendar | Wired via `skills/`. |

**Confirmed not installed. Zero references anywhere in the repo.**

`gstack`, `marketing-skills`, `claude-seo`, `financial-services`, `claude-for-legal`, `hyperframes`, `caveman`.

All except `hyperframes` and `caveman` are now forked into `forks/`.

**Ambiguous: `anthropics/skills`.** Zero repo references. The global-skills list in the agent `CLAUDE.md` files names `gmail`, `browser-harness`, `playwright-skill`, `humanizer`, `enhance-prompt`, `gdocs`, and none of the Anthropic pack. That points to not installed. It cannot be settled from here because plugin marketplaces are added inside a Claude Code session, which leaves no repo trace. Run `/plugin marketplace add anthropics/skills` on the host and let it no-op if already present.

Of that pack, `brand-guidelines` is the pick. It is the closest thing available to machine-enforcing DIR-001.

**Caveman note.** Jason stated this was already installed. A full repo search found zero references. If it is on the Windows host it was installed outside the repo. Recommendation is unchanged: remove it. See section 5.

---

## 5. Caveman is a constitutional breach. Do not install.

This is the one item to reject outright, and the guide recommends it in the Day 1 core.

Caveman rewrites agent replies into clipped "caveman-speak" to cut output tokens. Applied to this fleet it violates DIR-001 Humanization Law directly: every external output must pass a brand-voice check, and grunt-speak fails it by construction. Six agents talk to Jason over Telegram and to clients in writing. The Collective's entire positioning is that its output does not read like a machine.

Worse, Caveman ships `/caveman-compress <file>`, advertised for exactly this target:

> `/caveman-compress <file>` Rewrite a memory file (like `CLAUDE.md`) into caveman-speak. Cuts ~46% input tokens **every session after**.

`CLAUDE.md` here is 47 KB of constitutional doctrine governing six agents. Running that command would rewrite the Nine Rules, the sixteen active directives, and the delegation protocols into compressed grunt-speak. That is not a token optimization, it is a governance wipe.

The economics do not justify the risk either. Caveman's own README states input token savings of **0%**. It compresses replies only, which is the cheaper half of the bill.

**Ruling: blocked.** If token cost becomes a real problem, the lever is `/compact` and tighter delegation scope, which the guide already describes correctly under "Kondo".

---

## 6. Humanizer conflicts with DIR-001 and needs subordinating

Humanizer is the strongest single item on the list. It is built on Wikipedia's WikiProject AI Cleanup "Signs of AI writing" guide, which is a real and well-regarded reference, and the skill is substantive rather than a prompt wrapper.

One conflict. Humanizer's voice-calibration section explicitly allows em dashes back in:

> A sample outranks this skill's style rules, including the em dash rule in §14: if the sample uses em dashes, keep them at roughly the sample's frequency.

The Collective's rule is absolute: no em dashes, ever. Per the Standing Rule on technology stack hierarchy (step 2, fork to modify rather than use as-is), Humanizer is installed with an override layer at `skills/humanizer-collective/` that keeps its pattern library and subordinates its style arbitration to DIR-001.

---

## 7. What was installed

Five packs forked into `forks/` on 2026-07-26, upstream `.git` stripped so they are owned forks per Absorption Doctrine step 3. Rollout plan: `forks/INCORPORATION-PLAN.md`.

| Fork | Skills | Size | Tier | Owner |
|---|---|---|---|---|
| `gstack` | 59 | 19M | 3 | Engineering, project-scoped |
| `marketing-skills` | 48 | 4.5M | 2 | Melissa, James |
| `claude-seo` | 33 | 5.2M | 2 | Melissa, dormant |
| `financial-services` | 118 | 3.9M | 2 | Jackson |
| `claude-for-legal` | 151 | 4.8M | 2 | Sean, Melanie |

**409 skills, 37M.** gstack was trimmed of 29M of browser test fixtures and 9.4M of committed build output before vendoring.

Install on the Windows host by junction, so `git pull` updates the live skills with no reinstall step:

```powershell
powershell -ExecutionPolicy Bypass -File forks\install-addons.ps1 -Tier 2 -DryRun
powershell -ExecutionPolicy Bypass -File forks\install-addons.ps1 -Tier 2
```

Tier 3 adds gstack and needs bun first. See the incorporation plan, Phase 4.

**Not forked, deliberately:**
- `hyperframes` (172 MB). Video is not an active track and Higgsfield already covers generation.
- `caveman`. Blocked, section 5.

**Still needs a Claude Code session**, because plugin marketplaces cannot be added from a shell:
```
/plugin marketplace add anthropics/skills
/plugin install brand-guidelines
```

---

## 8. The thing the guide gets wrong that matters most

Its advice is "install the power-user core first, then one tool per real task." The second half is right. The first half is backwards for an operation like this one.

Every skill added to the global directory is context every agent carries into every session, forever. This fleet already runs a 47 KB constitutional `CLAUDE.md` across six agents. gstack alone is 59 more skill files. The guide's own "Common mistakes" section warns against installing all 24 at once and then its "Your first week" plan proceeds to install most of them in five days.

Scope installs to the agent that needs them. Global is for things all six should carry. Right now that list is short: humanizer and brand-guidelines.

---

## 9. Open items for Jason

1. **Container caveat.** This audit ran in an ephemeral remote container. Nothing was installed to a persistent `~/.claude/skills/`. ClaudeClaw runs on your Windows box, so the installs have to happen there. Run `scripts/install-addons.sh --tier 1` in Git Bash to do it.
2. **Notion, Zapier, Granola, Perplexity connectors are not evaluated.** Zapier in particular is a paid SaaS and falls foul of the Standing Rule on stack hierarchy, step 4. Before connecting it, state which open source automation options were rejected and why. n8n is the obvious fork candidate.
3. **Codex CLI is on the list and is not open source-neutral.** Running OpenAI's agent beside Claude for second opinions is defensible on merit. It is also a second vendor in the loop. Worth a decision, not a default.
