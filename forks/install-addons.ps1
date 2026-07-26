# install-addons.ps1 - Windows installer for the vetted add-on forks
# Run: powershell -ExecutionPolicy Bypass -File forks\install-addons.ps1
#
# Installs by junction, matching the forks\collective-goal\install.ps1 pattern.
# Junctions mean a `git pull` on this repo updates the live skills with no reinstall.
#
# Audit and rationale: docs\power-user-addons-audit.md
# Rollout plan:        forks\INCORPORATION-PLAN.md
#
# Usage:
#   -Tier 1      humanizer-collective only (already-installed humanizer keeps working)
#   -Tier 2      + marketing-skills, claude-seo, financial-services, claude-for-legal
#   -Tier 3      reserved (gstack is reference-only, see INCORPORATION-PLAN.md Phase 4)
#   -DryRun      show what would happen, change nothing
#   -Uninstall   remove the junctions this script created

param(
    [ValidateSet(1, 2, 3)][int]$Tier = 2,
    [switch]$DryRun,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$SkillsDir  = Join-Path $ClaudeHome "skills"
$RepoRoot   = Split-Path -Parent $Root

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Note($msg) { Write-Host "    $msg" }
function Write-Warn($msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }

# Source path, junction name, minimum tier
$Packs = @(
    @{ Name = "humanizer-collective"; Source = (Join-Path $RepoRoot "skills\humanizer-collective"); Tier = 1
       Note = "Override layer. Subordinates humanizer to DIR-001. Keeps the absolute no-em-dash rule." }
    @{ Name = "marketing-skills";     Source = (Join-Path $Root "marketing-skills\skills");        Tier = 2
       Note = "48 skills. Melissa and James. Scope per agent, do not carry all 48 fleet-wide." }
    @{ Name = "claude-seo";           Source = (Join-Path $Root "claude-seo");                     Tier = 2
       Note = "33 skills. Melissa. Dormant until search becomes an active track." }
    @{ Name = "financial-services";   Source = (Join-Path $Root "financial-services\plugins");     Tier = 2
       Note = "118 skills. Jackson. Margin floor, DSO, pipeline analysis." }
    @{ Name = "claude-for-legal";     Source = (Join-Path $Root "claude-for-legal");               Tier = 2
       Note = "151 skills. Sean and Melanie. Client contract review before signature." }
    # gstack is deliberately NOT listed. Reference fork only, never linked.
    # Its ethos is inlined into all 59 SKILL.md files and contradicts
    # docs\coding-discipline.md section 3. See forks\INCORPORATION-PLAN.md Phase 4.
    # The capability it was wanted for now lives in skills\plan-review.
    @{ Name = "plan-review";          Source = (Join-Path $RepoRoot "skills\plan-review");            Tier = 1
       Note = "Four-lens review (CEO, design, eng, QA). Runs under coding-discipline.md." }
)

if (-not (Test-Path $SkillsDir)) {
    if ($DryRun) { Write-Note "[dry-run] would create $SkillsDir" }
    else { New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null }
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    Write-Step "Uninstalling add-on junctions"
    foreach ($p in $Packs) {
        $link = Join-Path $SkillsDir $p.Name
        if (Test-Path $link) {
            if ($DryRun) { Write-Note "[dry-run] would remove $link" }
            else {
                cmd /c rmdir "$link" 2>$null
                if (Test-Path $link) { Remove-Item -Path $link -Recurse -Force -Confirm:$false }
                Write-Note "removed $($p.Name)"
            }
        } else {
            Write-Note "$($p.Name) not present, skipping"
        }
    }
    Write-Step "Done"
    exit 0
}

# ---------------------------------------------------------------- preflight
Write-Step "Preflight"

if ($Tier -ge 3) {
    Write-Warn "Tier 3 is reserved. gstack is a reference fork and is never linked."
    Write-Warn "Its ethos is inlined into all 59 SKILL.md files and contradicts"
    Write-Warn "docs\coding-discipline.md section 3. See forks\INCORPORATION-PLAN.md Phase 4."
    Write-Warn "The capability it was wanted for now lives in skills\plan-review."
}

Write-Note "skills dir: $SkillsDir"
Write-Note "tier:       $Tier"

# ---------------------------------------------------------------- install
Write-Step "Linking packs (tier $Tier)"

$linked = 0
foreach ($p in $Packs) {
    if ($p.Tier -gt $Tier) { continue }

    $link = Join-Path $SkillsDir $p.Name

    if (-not (Test-Path $p.Source)) {
        Write-Warn "$($p.Name): source missing at $($p.Source), skipping"
        continue
    }

    Write-Note ""
    Write-Note "$($p.Name)"
    Write-Note "  $($p.Note)"

    if ($DryRun) {
        Write-Note "  [dry-run] would junction $link -> $($p.Source)"
        continue
    }

    if (Test-Path $link) {
        cmd /c rmdir "$link" 2>$null
        if (Test-Path $link) { Remove-Item -Path $link -Recurse -Force -Confirm:$false }
    }

    cmd /c mklink /J "$link" "$($p.Source)" | Out-Null
    if (Test-Path $link) { Write-Note "  linked"; $linked++ }
    else { Write-Warn "  link failed for $($p.Name)" }
}

# ---------------------------------------------------------------- blocked
Write-Step "Blocked, deliberately not installed"
Write-Note "Caveman (JuliusBrussee/caveman)"
Write-Note "  Rewrites agent replies into caveman-speak. Breaches DIR-001 by construction."
Write-Note "  Ships /caveman-compress, advertised for rewriting CLAUDE.md. Ours is 47 KB of"
Write-Note "  doctrine governing six agents. Its own README reports 0% input token savings."
Write-Note "  Audit section 5. If it turns up in ~\.claude\skills, remove it."

Write-Step "Done"
Write-Note "$linked pack(s) linked."
Write-Note "Already installed separately, untouched by this script:"
Write-Note "  humanizer, superpowers, Codex CLI, agent-browser"
Write-Note ""
Write-Note "Still needs a Claude Code session (marketplaces cannot be added from a shell):"
Write-Note "  /plugin marketplace add anthropics/skills"
Write-Note "  /plugin install brand-guidelines"
Write-Note ""
Write-Note "Verify: dir `"$SkillsDir`""
