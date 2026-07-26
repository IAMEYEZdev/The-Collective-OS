#!/usr/bin/env bash
#
# install-addons.sh
#
# Tiered installer for the vetted subset of the "24 power-user add-ons" list.
# Audit and rationale: docs/power-user-addons-audit.md
#
# Every repo here was cloned and inspected on 2026-07-26. Commands are the
# corrected versions, not the ones printed in the source guide.
#
# Usage:
#   scripts/install-addons.sh --tier 1          # core, recommended default
#   scripts/install-addons.sh --tier 2          # core + revenue-adjacent
#   scripts/install-addons.sh --tier 3          # everything, heavy
#   scripts/install-addons.sh --tier 1 --dry-run
#
# Runs on Git Bash (Windows), macOS, and Linux.

set -euo pipefail

TIER=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)     TIER="${2:-1}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$TIER" in 1|2|3) ;; *) echo "Error: --tier must be 1, 2, or 3" >&2; exit 2 ;; esac

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    WARN: %s\033[0m\n' "$*" >&2; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '    [dry-run] %s\n' "$*"
  else
    printf '    $ %s\n' "$*"
    "$@"
  fi
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

log "Preflight"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required. Install v18 or newer from nodejs.org." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Error: Node.js 18+ required, found v${NODE_MAJOR}." >&2
  exit 1
fi
note "node v$(node -p 'process.versions.node') ok"

if [[ "$TIER" -ge 3 ]] && ! command -v bun >/dev/null 2>&1; then
  warn "bun is not installed. gstack (tier 3) will be skipped."
  warn "The source guide omits this. gstack's setup script hard-exits without bun."
  warn "Install from bun.sh, then re-run."
fi

# ----------------------------------------------------------------------------
# Tier 1: core. Low risk, immediately additive, safe to carry globally.
# ----------------------------------------------------------------------------

log "Tier 1: core"

note "Humanizer (blader/humanizer)"
note "  Wikipedia WikiProject AI Cleanup pattern library. Backs DIR-001."
note "  Governed by the override layer in skills/humanizer-collective/,"
note "  which restores the absolute no-em-dash rule that Humanizer relaxes."
run npx -y skills add blader/humanizer --global --yes

note "Find Skills CLI (vercel-labs/skills)"
note "  Search before building. 'npx skills find <topic>'."
run npx -y skills@latest --version

note "Anthropic official skills marketplace"
note "  Adds brand-guidelines, frontend-design, mcp-builder, claude-api and others."
note "  skill-creator, docx, pdf, pptx, xlsx, canvas-design and"
note "  web-artifacts-builder are already installed. The marketplace will not"
note "  duplicate them."
cat <<'EOF'

    Plugin marketplaces are added from inside Claude Code, not from bash.
    Paste these two lines into a Claude Code session:

      /plugin marketplace add anthropics/skills
      /plugin install brand-guidelines

    Then add frontend-design and mcp-builder only if a project needs them.

EOF

note "Superpowers: SKIPPED, already in use (see docs/superpowers/plans/)."

# ----------------------------------------------------------------------------
# Tier 2: revenue-adjacent. Scoped installs only.
# ----------------------------------------------------------------------------

if [[ "$TIER" -ge 2 ]]; then
  log "Tier 2: revenue-adjacent"

  note "Marketing Skills (coreyhaines31/marketingskills), scoped"
  note "  The repo ships 48 skills. Installing all 48 buries the useful ones."
  note "  Taking the five that map to the Authority track."
  run npx -y skills add coreyhaines31/marketingskills \
    --skill copywriting cro content-strategy social ads \
    --global --yes

  note "Claude SEO (AgriciDaniel/claude-seo): NOT installed by default."
  note "  33 skills. Search traffic is not an active track. Install only if"
  note "  that changes:  npx skills add AgriciDaniel/claude-seo --global"
fi

# ----------------------------------------------------------------------------
# Tier 3: heavy. Project-scoped, never global.
# ----------------------------------------------------------------------------

if [[ "$TIER" -ge 3 ]]; then
  log "Tier 3: heavy (project-scoped)"

  warn "These are large and opinionated. Install per project, not globally."

  note "Agent Browser (vercel-labs/agent-browser), 12 MB"
  run npx -y skills add vercel-labs/agent-browser --yes

  note "Hyperframes (heygen-com/hyperframes), 172 MB"
  note "  The LFS flag is required or the clone hangs. The guide gets this right."
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '    [dry-run] GIT_LFS_SKIP_SMUDGE=1 npx skills add heygen-com/hyperframes --yes\n'
  else
    GIT_LFS_SKIP_SMUDGE=1 npx -y skills add heygen-com/hyperframes --yes
  fi

  if command -v bun >/dev/null 2>&1; then
    note "gstack (garrytan/gstack), 70 MB, 59 skills"
    warn "gstack is a full development methodology. It will overlap and argue"
    warn "with docs/coding-discipline.md. Keep it out of ~/.claude/skills."
    note "  To install into a project instead:"
    note "    git clone --depth 1 https://github.com/garrytan/gstack .gstack"
    note "    cd .gstack && ./setup"
  else
    note "gstack: SKIPPED, bun not found."
  fi
fi

# ----------------------------------------------------------------------------
# Blocked
# ----------------------------------------------------------------------------

log "Blocked"
note "Caveman (JuliusBrussee/caveman): NOT INSTALLED, and not installable here."
note "  Rewrites agent replies into caveman-speak. Direct DIR-001 breach."
note "  Ships /caveman-compress, advertised for rewriting CLAUDE.md. This repo's"
note "  CLAUDE.md is 47 KB of constitutional doctrine governing six agents."
note "  Its own README reports 0% input token savings. See audit section 5."

log "Done (tier $TIER)"
note "Full audit: docs/power-user-addons-audit.md"
note "Verify what landed:  npx skills list"
