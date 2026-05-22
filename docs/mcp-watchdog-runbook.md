# MCP Watchdog Runbook

## What it does

Catches mid-session MCP server disconnects and recovers without user
intervention. When Claude Code's MCP client reports a server as
disconnected (and refuses to respawn it), the watchdog:

1. Classifies the error as `mcp_disconnect` and parses out the affected
   server name from the SDK error string.
2. Runs that server's wake-up command — a brief, side-effect-free call
   like `uvx --from basic-memory basic-memory --version` — so Claude Code's
   MCP client lazy-reconnects on the next tool call.
3. Waits 12 seconds for the handshake, polling the Layer 2 interrupt flag
   on every tick so a user halt always wins.
4. Re-runs the agent turn once with the same session ID, so Claude resumes
   the interrupted task.

If any sub-step cannot proceed (server not in registry, wake-up fails,
interrupt fires, retry cap reached) the watchdog surfaces the original
error to the user. **A broken watchdog must never block agents.**

## Granularity — turn-level retry, not tool-call retry

The watchdog retries the **whole turn**, not just the failed tool call.
The Claude Agent SDK iterator dies on first thrown error inside a turn;
there is no handle to re-execute one tool call. Resuming the same session
means Claude continues the task as its first action of the new turn,
which satisfies the user-visible spec ("retry the original tool call
once") even though the underlying mechanism is turn-level.

This matches every other retry strategy in `runAgentWithRetry`
(`normal`, `strip_images_and_retry`, `new_session`).

## Files changed

| File | Purpose |
|---|---|
| `src/errors.ts` | New `mcp_disconnect` category, `mcp_wakeup_and_retry` strategy, two-stage MCP detector, server-name extractor |
| `src/mcp-watchdog.ts` | Wake-up registry, 30s dedup, fire-and-forget spawn, interrupt-aware sleep helper |
| `src/agent.ts` | `checkInterruptFlag` exported; new MCP branch in `runAgentWithRetry` (cap 1, wake-up, wait, retry) |
| `src/bot.ts` | Distinct Telegram copy when `error.category === 'mcp_disconnect'` (no "(retry x/2)" suffix) |
| `src/errors.test.ts` | 12 new cases for MCP classification + name extraction |
| `src/mcp-watchdog.test.ts` | 13 new cases: registry, dedup, spawn-failure, wait-with-interrupt |

## Configuration

### Wake-up registry

Hardcoded in `src/mcp-watchdog.ts → MCP_WAKEUP_REGISTRY`. Currently:

```ts
'basic-memory': {
  command: process.env.MCP_BASIC_MEMORY_UVX || 'C:\\Users\\windows\\.local\\bin\\uvx.exe',
  args: ['--from', 'basic-memory', 'basic-memory', '--version'],
},
'apify': {
  command: process.env.MCP_APIFY_NPX || 'npx',
  args: ['@apify/actors-mcp-server', '--help'],
},
'graphiti': {
  command: process.env.MCP_GRAPHITI_UV || 'C:\\Users\\windows\\.local\\bin\\uv.exe',
  args: ['run', '--directory', '<graphiti-mcp-dir>', 'main.py', '--help'],
}
```

To add a new server, append a new entry. Keep the wake-up brief and
side-effect-free (a `--version` or `--help` call is ideal). Do **not**
use the server's main launch command — Claude Code will reconnect itself.

### Cycle logging

The watchdog maintains a rolling buffer of the last 100 MCP lifecycle
events (disconnect, wakeup_triggered, wakeup_success, wakeup_failed).
This enables pattern detection:

- `getCycleLog(serverName?)` — returns recent events, newest-first
- `isRapidCycling(serverName, windowMs?, threshold?)` — returns true
  if ≥5 disconnects occurred within 5 minutes (defaults)
- Rapid cycling triggers a warning log but does NOT block recovery
  attempts — a broken watchdog must never prevent work

### Tunables (env vars)

| Var | Default | Hard cap | Purpose |
|---|---|---|---|
| `MCP_WATCHDOG_MAX_RETRIES` | `1` | `3` | How many recovery attempts per disconnect cascade |
| `MCP_BASIC_MEMORY_UVX` | `C:\Users\windows\.local\bin\uvx.exe` | — | Override the basic-memory wake-up executable path |
| `MCP_APIFY_NPX` | `npx` | — | Override the apify wake-up executable path |
| `MCP_GRAPHITI_UV` | `C:\Users\windows\.local\bin\uv.exe` | — | Override the graphiti wake-up executable path |
| `MCP_GRAPHITI_DIR` | `C:\Users\windows\graphiti\mcp_server` | — | Override the graphiti MCP server directory |

### Constants in `src/mcp-watchdog.ts`

| Const | Default | Notes |
|---|---|---|
| `WAKEUP_COOLDOWN_MS` | `30_000` | Per-server dedup window — concurrent disconnects don't double-wake |
| `DEFAULT_WAKEUP_WAIT_MS` | `12_000` | Handshake wait between wake-up and retry |

## Observability

Every watchdog event logs through the project logger. Grep production
logs for `'MCP watchdog:'` to see the full lifecycle:

- `MCP watchdog: wake-up triggered` — the wake-up command was spawned
- `MCP watchdog: wake-up deduped (within cooldown)` — second concurrent retry
- `MCP watchdog: retrying turn after wake-up` — handshake done, calling SDK again
- `MCP watchdog: retry cap reached, surfacing original error` — gave up
- `MCP watchdog: interrupt observed during wake-up wait, retry aborted` — Layer 2 won
- `MCP watchdog: wake-up could not be triggered` — uvx missing, registry miss, etc

User-facing: when recovery succeeds, Telegram shows
> MCP server "basic-memory" reconnected. Continuing your request...

(no `(retry x/2)` suffix — the message is self-contained).

## Test plan — verification before merge

Tests 4 (non-MCP unaffected), 5 (concurrent dedup), 6 (no overhead in
success path), and 7 (logging) are covered by unit tests in
`src/errors.test.ts` and `src/mcp-watchdog.test.ts`. Tests 1–3 require
real Claude Code session interaction.

Run the unit suite first:
```bash
npx vitest run src/errors.test.ts src/mcp-watchdog.test.ts src/agent.test.ts
```
All 66 cases must pass. (Pre-existing failures in `skill-registry.test.ts`,
`memory.test.ts`, `memory-consolidate.test.ts` are unrelated to this work
and exist on `main`.)

### Test 1 — Disconnect simulation (manual)

1. Start the bot: `npm start`
2. Send Telegram: ask Melanie a task that requires basic-memory (e.g.
   "search memory for last week's notes").
3. While she's working, in PowerShell:
   ```powershell
   Get-Process | Where-Object { $_.ProcessName -like '*basic-memory*' -or ($_.CommandLine -like '*basic-memory*') } | Stop-Process -Force
   ```
   (or `taskkill /F /IM uvx.exe` if running via uvx wrapper)
4. Send Melanie a follow-up that uses basic-memory.

**Pass criteria:**
- Telegram shows `MCP server "basic-memory" reconnected. Continuing your request...`
- The follow-up tool call eventually completes (within ~15s after wake-up)
- Logs show `MCP watchdog: wake-up triggered` then
  `MCP watchdog: retrying turn after wake-up`

### Test 2 — Persistent failure (manual)

1. Rename the wake-up executable to break wake-up:
   ```powershell
   Rename-Item C:\Users\windows\.local\bin\uvx.exe uvx.exe.bak
   ```
2. Trigger a basic-memory call. Force-kill the server during it (test 1
   step 3).
3. Send a follow-up.

**Pass criteria:**
- Spawn fails — logs show `MCP watchdog: wake-up spawn failed` or
  `wake-up could not be triggered`
- Telegram shows the original disconnect error (NOT a recovery notice,
  NOT an infinite loop)
- Watchdog does not retry beyond cap 1

Restore: `Rename-Item C:\Users\windows\.local\bin\uvx.exe.bak uvx.exe`

### Test 3 — Layer 2 coexistence (manual)

1. Trigger a basic-memory call that will fail (kill the process as
   test 1 step 3).
2. Within the 12-second wake-up wait window, in PowerShell:
   ```powershell
   Stop-Melanie
   ```
3. Wait for Telegram message.

**Pass criteria:**
- Telegram shows `🛑 HALTED (harness interrupt)` (the Layer 2 message),
  NOT `MCP server "..." reconnected. Continuing your request...`
- Logs show `MCP watchdog: interrupt observed during wake-up wait, retry aborted`
- Resume with `Resume-Melanie` afterwards

### Test 4 — Non-MCP errors unaffected (unit-covered)

Verified by `errors.test.ts` cases:
- `'leaves non-MCP errors unaffected by the new patterns'`
- `'classifies network errors'`, `'classifies timeout errors'`,
  `'classifies authentication errors'`, etc — still classify correctly
  with MCP detection placed first in the cascade.

### Test 5 — Concurrent disconnect dedup (unit-covered)

Verified by `mcp-watchdog.test.ts`:
- `'dedups within the cooldown window without spawning twice'` — 3 calls,
  1 spawn

### Test 6 — No-disconnect baseline / zero overhead (unit-covered + structural)

The watchdog branch in `runAgentWithRetry` only fires when `strategy ===
'mcp_wakeup_and_retry'`, which only sets when `classifyError` matched the
MCP detector. Success path: no error → no classifier → no watchdog.
Existing 7 cases in `agent.test.ts` continue to pass with no slowdown.

### Test 7 — Logging (structural)

Every watchdog state-change emits a log line tagged `MCP watchdog:`. Grep:

```bash
grep -E "MCP watchdog:" src/mcp-watchdog.ts src/agent.ts
```

10 distinct log points cover every branch.

## Failure-mode reference

| Failure | Watchdog behaviour |
|---|---|
| Server not in `MCP_WAKEUP_REGISTRY` | `triggerWakeup` returns false → throw original error |
| Wake-up spawn throws synchronously | Caught in `triggerWakeup` → returns false → throw original |
| Wake-up spawn returns non-zero / process crashes | We don't await it; if the post-wait retry fails, we hit the cap and throw |
| Server name not parseable from error string | Branch returns false → throw original |
| Layer 2 interrupt during wake-up wait | Abort signal set, throw original (caught by Layer 2 path upstream) |
| MCP_RETRY_HARD_CAP exceeded | Throw original |
| Pattern matcher itself errors | Try/catch in `extractMcpServerName`; matchesAny is plain substring (cannot throw) |

## Merge command

After all 3 manual tests pass:

```bash
git checkout main && git merge mcp-watchdog --no-ff -m "feat: MCP watchdog — auto-recover from mid-session MCP disconnects"
```

Do **not** push to remote until the user has run the manual tests and
verified production behaviour.
