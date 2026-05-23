# install.ps1 — Windows installer for The Collective /goal skill
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$SkillsDir = Join-Path $ClaudeHome "skills"
$GoalStateDir = Join-Path $ClaudeHome "goal"
$SettingsPath = Join-Path $ClaudeHome "settings.json"

# Create directories
foreach ($dir in @($SkillsDir, (Join-Path $ClaudeHome "commands"), $GoalStateDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# Create junction (Windows equivalent of symlink) for the skill
$SkillLink = Join-Path $SkillsDir "goal"
if (Test-Path $SkillLink) {
    # Remove existing link/directory
    cmd /c rmdir "$SkillLink" 2>$null
    if (Test-Path $SkillLink) {
        Remove-Item -Path $SkillLink -Recurse -Force -Confirm:$false
    }
}
$GoalSource = Join-Path $Root "goal"
cmd /c mklink /J "$SkillLink" "$GoalSource"

# Remove legacy command shim if it exists
$LegacyShim = Join-Path $ClaudeHome "commands" "goal.md"
if (Test-Path $LegacyShim) {
    Remove-Item -Path $LegacyShim -Force -Confirm:$false
}

# Update settings.json to add Stop hook
$ScriptPath = Join-Path $Root "goal" "scripts" "claude_goal.py"
$HookCommand = "python3 $ScriptPath stop-hook"

if (Test-Path $SettingsPath) {
    $data = Get-Content $SettingsPath -Raw -Encoding utf8 | ConvertFrom-Json
} else {
    $data = New-Object PSObject
}

# Ensure hooks.Stop exists
if (-not ($data.PSObject.Properties.Name -contains "hooks")) {
    $data | Add-Member -NotePropertyName "hooks" -NotePropertyValue (New-Object PSObject)
}
if (-not ($data.hooks.PSObject.Properties.Name -contains "Stop")) {
    $data.hooks | Add-Member -NotePropertyName "Stop" -NotePropertyValue @()
}

# Check if hook already exists
$hookExists = $false
foreach ($item in $data.hooks.Stop) {
    if ($item.hooks) {
        foreach ($hook in $item.hooks) {
            if ($hook.command -eq $HookCommand) {
                $hookExists = $true
                break
            }
        }
    }
    if ($hookExists) { break }
}

if (-not $hookExists) {
    $newEntry = @{
        matcher = ""
        hooks = @(
            @{
                type = "command"
                command = $HookCommand
            }
        )
    }
    $data.hooks.Stop += $newEntry
}

$data | ConvertTo-Json -Depth 10 | Out-File -FilePath $SettingsPath -Encoding utf8

Write-Host "Installed /goal for Claude Code (The Collective edition)."
Write-Host "Skill: $SkillLink"
Write-Host "Stop hook: $HookCommand"
Write-Host "State DB: $GoalStateDir\goals.sqlite"
