#!/usr/bin/env bash
#
# install-addons.sh - bash twin of forks/install-addons.ps1
#
# Links the vetted add-on forks into ~/.claude/skills by symlink, so a
# `git pull` on this repo updates the live skills with no reinstall step.
#
# Windows is the primary host. Use forks/install-addons.ps1 there (junctions).
# This script is for macOS, Linux, and WSL.
#
# Audit:  docs/power-user-addons-audit.md
# Plan:   forks/INCORPORATION-PLAN.md
#
# Usage:
#   scripts/install-addons.sh --tier 2               # recommended default
#   scripts/install-addons.sh --tier 2 --dry-run
#   scripts/install-addons.sh --uninstall

set -euo pipefail

TIER=2
DRY_RUN=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)      TIER="${2:-2}"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$TIER" in 1|2|3) ;; *) echo "Error: --tier must be 1, 2, or 3" >&2; exit 2 ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORKS="$REPO_ROOT/forks"
SKILLS_DIR="${HOME}/.claude/skills"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    WARN: %s\033[0m\n' "$*" >&2; }

# name | source path | min tier | note
PACKS=(
  "humanizer-collective|$REPO_ROOT/skills/humanizer-collective|1|Override layer. Subordinates humanizer to DIR-001."
  "marketing-skills|$FORKS/marketing-skills/skills|2|48 skills. Melissa and James. Scope per agent."
  "claude-seo|$FORKS/claude-seo|2|33 skills. Melissa. Dormant until search is an active track."
  "financial-services|$FORKS/financial-services/plugins|2|118 skills. Jackson. Margin floor, DSO, pipeline."
  "claude-for-legal|$FORKS/claude-for-legal|2|151 skills. Sean and Melanie. Contract review."
  "plan-review|$REPO_ROOT/skills/plan-review|1|Four-lens review (CEO, design, eng, QA). Runs under coding-discipline.md."
  # gstack deliberately absent. Reference fork only, never linked. Its ethos is
  # inlined into all 59 SKILL.md files and contradicts coding-discipline.md s3.
  # See forks/INCORPORATION-PLAN.md Phase 4.
)

if [[ $UNINSTALL -eq 1 ]]; then
  log "Uninstalling add-on links"
  for entry in "${PACKS[@]}"; do
    IFS='|' read -r name _src _tier _note <<< "$entry"
    link="$SKILLS_DIR/$name"
    if [[ -L "$link" || -e "$link" ]]; then
      if [[ $DRY_RUN -eq 1 ]]; then note "[dry-run] would remove $link"
      else rm -rf "$link"; note "removed $name"; fi
    else
      note "$name not present, skipping"
    fi
  done
  log "Done"
  exit 0
fi

log "Preflight"

if [[ ! -d "$FORKS" ]]; then
  echo "Error: $FORKS not found. Run from a full clone." >&2
  exit 1
fi

if [[ "$TIER" -ge 3 ]]; then
  warn "Tier 3 is reserved. gstack is a reference fork and is never linked."
  warn "Its ethos is inlined into all 59 SKILL.md files and contradicts"
  warn "docs/coding-discipline.md section 3. See forks/INCORPORATION-PLAN.md Phase 4."
  warn "The capability it was wanted for now lives in skills/plan-review."
fi

note "skills dir: $SKILLS_DIR"
note "tier:       $TIER"

[[ $DRY_RUN -eq 1 ]] || mkdir -p "$SKILLS_DIR"

log "Linking packs (tier $TIER)"

linked=0
for entry in "${PACKS[@]}"; do
  IFS='|' read -r name src tier ptext <<< "$entry"
  [[ "$tier" -gt "$TIER" ]] && continue

  if [[ ! -e "$src" ]]; then
    warn "$name: source missing at $src, skipping"
    continue
  fi

  note ""
  note "$name"
  note "  $ptext"

  link="$SKILLS_DIR/$name"
  if [[ $DRY_RUN -eq 1 ]]; then
    note "  [dry-run] would link $link -> $src"
    continue
  fi

  rm -rf "$link"
  ln -s "$src" "$link"
  note "  linked"
  linked=$((linked + 1))
done

log "Blocked, deliberately not installed"
note "Caveman (JuliusBrussee/caveman)"
note "  Rewrites agent replies into caveman-speak. Breaches DIR-001 by construction."
note "  Ships /caveman-compress, advertised for rewriting CLAUDE.md. Ours is 47 KB of"
note "  doctrine governing six agents. Its own README reports 0% input token savings."
note "  Audit section 5. If it turns up in ~/.claude/skills, remove it."

log "Done"
note "$linked pack(s) linked."
note "Already installed separately, untouched: humanizer, superpowers, Codex CLI, agent-browser."
note ""
note "Still needs a Claude Code session (marketplaces cannot be added from a shell):"
note "  /plugin marketplace add anthropics/skills"
note "  /plugin install brand-guidelines"
note ""
note "Verify: ls -la $SKILLS_DIR"
