# vnpy-mmv-execution-algos: Selective Extraction (NOT a full fork)

**Authority:** Jason (Founder), relayed via Melanie
**Date filed:** 2026-06-18
**Status:** QUEUED / DEFERRED -- do NOT start yet
**Agent:** Neo (Engineering Chamber)
**Fork name (if needed):** `vnpy-mmv-execution-algos`

## Gating (hard blocker -- do not begin)

Do NOT start this task until ALL of the following are confirmed COMPLETE:

- lean-mmv
- rd-agent-mmv
- open-terminal-ui-mmv

Earliest start: **POST July 4th sprint.**

## Source

- Repo: https://github.com/vnpy/vnpy
- License: MIT

## Scope: extract ONLY two modules. Do not fork the full framework.

### a) Options analytics module
Source: `vnpy_optionmaster` (or equivalent).
Extract:
- Greek calculations: delta, gamma, theta, vega
- Live volatility surface
- Options analytics

Rationale: fills a gap in the current MMV stack -- no existing layer covers options analytics.

### b) Smart execution algos
Source: vnpy spread / execution (algo trading) layer.
Extract:
- TWAP
- Iceberg
- The algo logic that works large orders into the market without price impact

Extract the **algo logic only** -- NOT the gateway dependencies.

## Integration target

Wire these as **standalone Python modules** that sit between:
- Decision layer: AutoHedge / Vibe-Trading
- Execution layer: IBKR MCP

Constraints:
- Must NOT require vnpy's full event engine.
- Must NOT require the Qt desktop app.

## Explicitly OUT OF SCOPE

- vnpy ML module (modeled on Qlib) -- skip entirely; we have qlib-mmv (the original).
- Chinese market gateways (CTP, etc.).
- Any gateway dependencies.

## Priority

Low / deferred. Keep the fork narrow: options analytics + smart execution only.
