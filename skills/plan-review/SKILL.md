---
name: plan-review
description: |
  Multi-lens review of a plan, spec, or diff. Runs four independent passes
  (CEO, design, engineering, QA) and reconciles them into one call. Use before
  committing to any non-trivial build, before shipping a client deliverable,
  or when a plan feels right but you cannot say why. Triggers: "review this
  plan", "sanity check this before I build", "what am I missing", "CEO review",
  "eng review", "design review", "QA pass".
metadata:
  version: "1.0.0"
  governs-under: "docs/coding-discipline.md"
  origin: "Structure adapted from garrytan/gstack review cluster. Ethos deliberately not imported. See forks/INCORPORATION-PLAN.md Phase 4."
---

# Plan Review, Four Lenses

One reviewer with four hats is worse than four reviewers with one each. Run the
lenses separately, then reconcile. Do not blend them as you go.

**This skill runs under `docs/coding-discipline.md`.** Where any lens below
suggests work outside the causal path of the request, coding-discipline §3
wins. Completeness is not a virtue here. Fitness for purpose is.

---

## Before you start

State two things in one line each:

1. **Posture** (from coding-discipline §2): prototype, maintenance, infrastructure, or refactor. The posture sets the bar every lens judges against.
2. **What is irreversible here** (from coding-discipline §1): schema, public API, migration, external integration, anything a client sees. Those get the scrutiny. Everything else gets a decision and a move on.

If the posture is prototype and nothing is irreversible, run the CEO lens only and stop. The other three are overhead on throwaway work.

---

## Lens 1: CEO

The question is not "is this good". It is "does this advance revenue or capability, and is it the best available use of this hour".

- Which vector does this move: revenue, technological superiority, or both? If neither, say so plainly and stop the review there.
- What is the revenue proximity? Direct billable, pipeline-adjacent, or infrastructure that pays off later?
- What is the opportunity cost? Name the thing not getting built because this is.
- Is this reversible if wrong? What does backing out cost in days?
- Does it create a dependency on a paid tool or external vendor? If so, which open source options were evaluated and rejected, and why. Stack hierarchy applies.

**Output:** one of `advance`, `advance with changes`, `defer`, `kill`. With one sentence of reasoning. No hedging.

## Lens 2: Design

Applies to anything a human sees: UI, documents, reports, CLI output, client deliverables.

- Is the first thing the reader sees the most important thing? If not, reorder.
- What is the reader supposed to do after reading this? If that is unclear, the design has failed regardless of how it looks.
- Where does it break: long text, empty state, error state, small screen, printed to PDF?
- Does the output pass DIR-001? No em dashes, no AI cliches, no puffery. Run `humanizer` then `humanizer-collective` on any prose.
- For deliverables to Jason or a client: PDF, per DIR-007. Verified end to end, per DIR-009.

**Output:** the single highest-impact change, plus a list of breakages. Not a wishlist.

## Lens 3: Engineering

- Does the plan name its success criterion, and is it checkable? Weak criteria produce rework. Coding-discipline §4.
- What is the blast radius? Use GitNexus (`impact <filePath>`) rather than guessing.
- Which step is the one most likely to fail, and what is the fallback?
- Is the diff scoped to the causal path, or is adjacent improvement smuggled in? Flag every changed line that does not trace to the request.
- Are there hidden sequencing constraints? Anything that must land before something else?
- What existing code already does part of this? Search before building. Duplicated capability is a maintenance tax forever.

**Output:** the riskiest step, the blast radius, and any scope creep found. Be specific about file and line.

## Lens 4: QA

- What is the test that would fail today and pass when this is done? If nobody can name it, the work is not defined yet.
- For a bug fix: does a test reproduce the bug first? Coding-discipline §4.
- For a refactor: do tests pass before and after? If there are no tests, write the minimum needed to pin behaviour before touching anything.
- What breaks that is not in the diff? Callers, config, cron jobs, other agents that depend on this surface.
- What does failure look like in production, and how would we notice? Silent failure is the expensive kind.
- Governed surfaces: does this write to anything in `src/gate/governed-surface-registry.json`? If so, Bash-only per Rule 10.

**Output:** the verification check per step, and the failure mode nobody has considered.

---

## Reconcile

The lenses will disagree. That is the point. Do not average them.

1. **CEO `kill` or `defer` ends it.** No further review needed. Report and stop.
2. **Where engineering and CEO conflict** (a fast path that costs capability, or a clean path that misses the window), surface both to Jason with a recommendation. Do not silently pick.
3. **Where design and engineering conflict**, design wins on anything a client sees. Engineering wins on anything internal.
4. **QA is a gate, not a vote.** If QA cannot name a verification check, the plan is not ready regardless of what the other three said.

## Output format

Keep it short. A review longer than the plan it reviews has failed.

```
POSTURE: [prototype | maintenance | infrastructure | refactor]
IRREVERSIBLE: [what, or "nothing"]

CEO:    [advance | advance with changes | defer | kill] - [one sentence]
DESIGN: [highest-impact change, or "n/a, nothing user-facing"]
ENG:    [riskiest step + blast radius]
QA:     [the verification check, or "BLOCKED: no checkable criterion"]

CALL:   [what to do, one line]
WATCH:  [the one thing most likely to go wrong]
```

## What this skill deliberately does not do

It does not recommend full coverage by default. It does not treat completeness
as the goal. It does not expand scope to adjacent code because the marginal
cost is low.

Those are gstack's principles and they are coherent on greenfield work where
nobody depends on the result yet. They are the wrong default for a running
six-agent system where most work is maintenance posture on code other agents
call. Coding-discipline §3 governs: every changed line serves the stated goal
or the causal path to it.

If a build is genuinely greenfield and throwaway, say so in the posture line
and the CEO lens will let it through fast.
