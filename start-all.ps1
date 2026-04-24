# ==============================================================================
#  ClaudeClaw - Start All Agents
# ==============================================================================
#  What this does:
#    1. Spawns each of the 5 sub-agents (comms, content, custom, ops, research)
#       in its own separate PowerShell window, titled with the agent's name.
#    2. Starts the main orchestrator (Melanie) in THIS window.
#
#  How to use:
#    - From PowerShell in the project folder, run:  .\start-all.ps1
#
#  How to stop:
#    - Close any individual agent's window to stop just that agent.
#    - Close this window (or press Ctrl+C) to stop Melanie.
#    - Close all windows to stop everything.
# ==============================================================================

# --- CONFIG -------------------------------------------------------------------
$ProjectRoot = "C:\Users\windows\claudeclaw-os"

$SubAgents = @(
    "custom",
    "research",
    "content",
    "comms",
    "ops"
)

$SpawnDelayMs = 800
# ------------------------------------------------------------------------------


if (-not (Test-Path $ProjectRoot)) {
    Write-Host "ERROR: Project folder not found at $ProjectRoot" -ForegroundColor Red
    Write-Host "Edit the ProjectRoot variable at the top of this script." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Set-Location $ProjectRoot

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " ClaudeClaw - Starting all agents"              -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

foreach ($agent in $SubAgents) {
    Write-Host "  Spawning sub-agent: $agent" -ForegroundColor Green

    $cmd = "`$Host.UI.RawUI.WindowTitle = 'ClaudeClaw Agent: $agent'; Set-Location '$ProjectRoot'; node dist/index.js --agent $agent"

    Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd | Out-Null

    Start-Sleep -Milliseconds $SpawnDelayMs
}

Write-Host ""
Write-Host "All sub-agents launched. Starting main orchestrator (Melanie)..." -ForegroundColor Green
Write-Host ""
Start-Sleep -Milliseconds 500

npm start
