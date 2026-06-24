# lean-mmv: IBKR Broker Decision (BLOCKER RESOLVED)

**Authority:** Jason (Founder), relayed via Melanie
**Date:** 2026-06-18
**Status:** ACTIVE -- unblocks lean-mmv fork
**Agent:** Neo (Engineering Chamber)

## Decision

Interactive Brokers (IBKR) is confirmed as the **primary live-execution broker target** for lean-mmv.

## Directive

In the LEAN fork (lean-mmv):

1. **RETAIN** the LEAN IB brokerage plugin: `Lean.Brokerages.InteractiveBrokers`.
2. **STRIP** all other brokerage plugins from the fork (GDAX/Coinbase, Bitfinex, OANDA, Tradier, FXCM, Binance, Alpaca, Kraken, Bybit, etc.). Keep only the IBKR brokerage path plus whatever shared brokerage interfaces/abstractions IBKR depends on.
3. Verify the fork still builds with only the IBKR brokerage retained.

## Effect

This resolves the broker-selection blocker that was holding the lean-mmv fork. Resume the fork work.

## Context

- lean-mmv is part of the MMV stack alongside rd-agent-mmv, open-terminal-ui-mmv, and qlib-mmv.
- IBKR is also the live-execution target referenced by the future vnpy-mmv-execution-algos extraction (smart execution algos sit between the decision layer and the IBKR MCP execution layer).
