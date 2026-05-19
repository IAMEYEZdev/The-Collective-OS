# Coding Discipline (applies to all implementation work)

Four principles govern how you approach code changes. They bias toward judgment over rigid rules.

## 1. Think Before Coding — and know which unknowns matter.

State assumptions explicitly before writing code. When multiple interpretations exist, present them rather than picking silently.
Not all unknowns deserve a question. Rank them by reversibility:
  - Irreversible or high-cost to change (schema choices, public API contracts, function signatures others will depend on, database migrations, external integrations): ask before committing.
  - Reversible or low-cost to change (local variable names, internal algorithm choice, file organisation within a module): pick and proceed. Adjust later if wrong.

Asking too many questions stalls work. Asking too few ships bad commitments. The irreversibility test tells you which is which.

## 2. Context-Aware Reasoning — match the solution to the context.

Before starting any non-trivial task, identify which posture applies, and state it explicitly:
  - **Prototype posture** — exploratory work, throwaway scripts, spike solutions. Optimise for speed. Minimal code. Don't worry about edge cases or future extensibility. If it works once for the demonstrated use, it's done.
  - **Maintenance posture** — bug fixes in existing code. Maximum surgical precision. Smallest possible diff. Match existing style rigorously. Don't take the opportunity to refactor.
  - **Infrastructure posture** — building shared code that other parts of the system will depend on (CLIs, libraries, abstractions, orchestration logic). Slightly more thorough. Handle obvious edge cases. Consider near-term future needs. But still resist speculative flexibility for needs that haven't been identified.
  - **Refactor posture** — intentionally improving existing code without changing behaviour. Preserve behaviour rigorously. Ensure tests pass before and after (write them first if absent). Change structure, not semantics.

State your posture at the start. Example: "This is infrastructure posture — building a CLI other agents will call, so I'll include basic error handling and cover the obvious subcommands." The posture governs how you interpret the remaining principles.

Ask yourself: "Would a senior engineer say this is fit-for-purpose?" Not too simple, not too elaborate — right for its context.

## 3. Surgical Changes — scoped to the causal path.

Touch what the request requires, plus anything on the direct causal path to making that change correct. If fixing X requires also fixing Y because X genuinely depends on Y, Y is in scope.

**Out of scope:**
  - Improving adjacent code that merely sits near your change.
  - Refactoring style, comments, or formatting you'd do differently.
  - Deleting pre-existing dead code unless asked.

**In scope:**
  - Bugs on the causal path to your task (mention them, fix them, flag them in your report).
  - Orphans your changes created: unused imports, now-dead helper functions from code you modified. Clean those up.

The test: every changed line should serve the stated goal or the causal path to it. Not your aesthetic preferences.

## 4. Goal-Driven Execution — with calibrated verification.

Every non-trivial task needs an explicit success criterion. The form of verification depends on what you're doing.
  - Code changes with testable behaviour: write or identify a test that reproduces the desired state, then make it pass.
  - Bug fixes: write a test that reproduces the bug first, then make it pass.
  - Refactors: tests must pass before AND after. If there are no tests, write the minimal tests needed to pin behaviour first.
  - Config/text edits (CLAUDE.md, .env, documentation): grep/list-based verification is sufficient — confirm expected strings present, unexpected strings absent.
  - Multi-step orchestration: state a brief plan with a verification check per step. Loop until each check passes.

For multi-step work, the plan format is:
  1. [Step] -> verify: [check]
  2. [Step] -> verify: [check]
  3. [Step] -> verify: [check]

Strong, calibrated success criteria let you loop independently. Weak criteria ("make it work") produce constant clarification and rework.

## Meta-guidance

These principles are calibration dials, not rules. For trivial edits (typo fixes, single config values, one-line constants), use judgment — don't ceremonially walk the framework.

The principles are working if: diffs contain only changes that trace to the request or its causal path, posture is stated before implementation begins, clarifying questions arrive before commitments rather than after mistakes, and verification is visible in the work rather than implicit.
