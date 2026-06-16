# Startup Performance Diagnosis, Sprint 001

Date: 2026-06-16

## Finding

Agent startup slowness is most strongly explained by local context noise, not by a single slow TypeScript import. The repo has a large number of untracked local surfaces and very large nested trees that agent runtimes and Git discovery can touch during startup.

## Evidence

- `CLAUDE.md`: 48,576 bytes.
- `AGENTS.md`: 8,065 bytes.
- Required `context/*.md`: 16,499 bytes total.
- `git status --short`: about 408 ms before local excludes.
- Top local directory sizes by recursive entry count:
  - `forks`: about 327,160 entries.
  - `warroom`: about 30,505 entries.
  - `node_modules`: about 27,441 entries.
  - `workspace`: about 18,050 entries.
  - `.claude`: about 2,565 entries.
- `.claude/settings.json` already denies reads of `node_modules`, `dist`, `.git`, package lock, maps, cache, and coverage, but it does not exclude large project-local sandboxes such as `forks`, `workspace`, `.claude`, or `warroom`.

## Applied Optimization

Added local-only Git excludes in `.git/info/exclude` for heavy generated, sandbox, runtime, and artifact paths. This reduces startup context noise on this machine without changing shared repository behavior.

## Deferred Changes

No `.claudeignore`, `.gitignore`, or prompt-governance edits were made for this task. Those are shared behavior changes and should be handled through the governance gate if Jason wants the optimization enforced for every agent and every clone.

## Recommendation

For a durable shared fix, add a governed `.claudeignore` or equivalent agent-context ignore rule for:

- `forks/`
- `workspace/`
- `.claude/`
- `.omx/`
- `warroom/`
- generated PDFs, screenshots, and Playwright scratch scripts

Keep `CLAUDE.md` and `AGENTS.md` concise. They are not the biggest measured filesystem issue, but they are loaded into every relevant agent startup path.
