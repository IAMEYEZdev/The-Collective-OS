# Layer 2: Interrupt Hook Runbook

## What it does

A pre-tool-use hook that checks for a flag file before every tool call.
If `C:\Users\windows\hive\control\interrupt.flag` exists, the agent halts
immediately. The tool does NOT execute.

## PowerShell commands

Open any PowerShell window (functions load from your profile automatically):

```powershell
Stop-Melanie      # Create flag file → agent halts at next tool call
Resume-Melanie    # Remove flag file → agent can proceed
```

## How it works

1. Agent receives assistant message from SDK with `tool_use` blocks
2. Before the SDK dispatches each tool, `checkInterruptFlag()` runs
3. If flag file exists: reads reason, aborts via AbortController, returns halt report
4. If flag file missing or unreadable: returns null, agent proceeds normally
5. Halt message sent to user via Telegram/dashboard with reason and last tool name

## Files changed

- `src/agent.ts` — interrupt flag check + abort on tool detection
- `src/bot.ts` — halt message formatting (both Telegram and dashboard handlers)
- `Microsoft.PowerShell_profile.ps1` — Stop-Melanie / Resume-Melanie functions

## Halt message format

```
🛑 HALTED (harness interrupt)
Reason: {reason from flag file}
Last detected tool: {tool_name}
State: flag file at C:\Users\windows\hive\control\interrupt.flag triggered this halt
To resume: run Resume-Melanie in PowerShell, then send the agent a new instruction.
```

## Test plan

### Test 1: Flag file present → agent halts
```powershell
Stop-Melanie
```
Then send agent a task requiring a tool call. Verify: agent halts with the
halt message. Tool does not execute.

### Test 2: No flag file → agent runs normally
```powershell
Resume-Melanie
```
Send same task. Verify: agent executes tool normally.

### Test 3: Mid-task interrupt
Send agent a long-running task. While running, in a separate terminal:
```powershell
Stop-Melanie
```
Verify: agent halts at the NEXT tool call boundary.

### Test 4: No hive/control/ directory
```powershell
Remove-Item "$HOME\hive\control" -Recurse -Force -ErrorAction SilentlyContinue
```
Send agent a task. Verify: runs normally, no errors.

### Test 5: Stop-Melanie from cold PowerShell
Open a new PowerShell window. Run `Stop-Melanie`.
Verify: creates directory if needed, creates flag file, prints red confirmation.

### Test 6: Resume-Melanie when flag doesn't exist
```powershell
Resume-Melanie
```
When no flag exists. Verify: silently succeeds, prints green confirmation.

### Test 7: Race condition verification
```powershell
Stop-Melanie
```
Send agent: "create a file called C:\Users\windows\hive\control\test-race.txt"
Verify: (a) agent halts, (b) test-race.txt does NOT exist.

## Merge command

After all 7 tests pass:
```bash
git checkout main && git merge layer-2-interrupt-hook --no-ff -m "Layer 2: Add interrupt hook for constitutional agent halt"
```
