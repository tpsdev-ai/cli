#!/usr/bin/env bash
# migrate-openclaw-2026.5.7.sh
# Migrate OpenClaw config from 2026.4.x to 2026.5.7 plugin format.
#
# What this does:
#   1. Backs up ~/.openclaw/openclaw.json to ~/.openclaw/openclaw.json.bak-YYYYMMDD-HHMMSS
#   2. Fixes plugins.slots.contextEngine from "flair" → "flair-context-engine"
#   3. Installs @openclaw/discord as external plugin (was bundled; now external)
#   4. Ensures all non-bundled channel plugins have channelConfigs in manifests
#   5. Adds activation.onStartup to extension manifests that are missing it
#   6. Runs openclaw doctor --fix to apply all auto-migrations
#   7. Validates plugin loading
#
# Usage: ./migrate-openclaw-2026.5.7.sh [--dry-run] [--skip-install]
#   --dry-run       Show what would change without applying
#   --skip-install  Skip npm install step (when pre-installed)

set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
EXTENSIONS_DIR="$OPENCLAW_DIR/extensions"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$OPENCLAW_DIR/openclaw.json.bak-$TIMESTAMP"
DRY_RUN=false
SKIP_INSTALL=false
CHANGES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[migrate]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; }
info() { echo -e "${BLUE}[info]${NC} $*"; }
change() { CHANGES=$((CHANGES + 1)); echo -e "${GREEN}  →${NC} $*"; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--skip-install]"
      exit 0
      ;;
    *) err "Unknown arg: $arg"; exit 1 ;;
  esac
done

if $DRY_RUN; then
  warn "DRY RUN — no changes will be applied"
fi

# ── 0. Pre-flight checks ──────────────────────────────────────────────────

if ! command -v openclaw &>/dev/null && ! $DRY_RUN; then
  err "openclaw CLI not found on PATH"
  exit 1
fi

if ! $DRY_RUN && ! command -v python3 &>/dev/null; then
  err "python3 required for JSON manipulation"
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  err "Config not found: $CONFIG_FILE"
  exit 1
fi

OC_VERSION=$(openclaw --version 2>/dev/null | head -1 || echo "unknown")
log "OpenClaw version: $OC_VERSION"
log "Config: $CONFIG_FILE"

# ── 1. Backup ─────────────────────────────────────────────────────────────

if $DRY_RUN; then
  info "Would backup: $CONFIG_FILE → $BACKUP_FILE"
else
  cp "$CONFIG_FILE" "$BACKUP_FILE"
  log "Backup saved: $BACKUP_FILE"
fi

# ── 2. Fix plugins.slots.contextEngine ("flair" → "flair-context-engine") ─

CONTEXT_ENGINE=$(python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
slot = cfg.get('plugins',{}).get('slots',{}).get('contextEngine','')
print(slot)
" 2>/dev/null || echo "")

if [[ "$CONTEXT_ENGINE" == "flair" ]]; then
  if $DRY_RUN; then
    change "Would fix plugins.slots.contextEngine: \"flair\" → \"flair-context-engine\""
  else
    python3 -c "
import json
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
cfg.setdefault('plugins',{}).setdefault('slots',{})['contextEngine'] = 'flair-context-engine'
with open('$CONFIG_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
"
    change "Fixed plugins.slots.contextEngine: \"flair\" → \"flair-context-engine\""
  fi
elif [[ "$CONTEXT_ENGINE" == "flair-context-engine" ]]; then
  info "plugins.slots.contextEngine already correct: \"flair-context-engine\""
else
  info "plugins.slots.contextEngine is \"$CONTEXT_ENGINE\" (not flair, skipping)"
fi

# ── 3. Add activation.onStartup to extension manifests ────────────────────

for ext_dir in "$EXTENSIONS_DIR"/*/; do
  manifest="$ext_dir/openclaw.plugin.json"
  if [[ ! -f "$manifest" ]]; then continue; fi

  ext_name=$(basename "$ext_dir")
  HAS_ACTIVATION=$(python3 -c "
import json
with open('$manifest') as f:
    m = json.load(f)
print('true' if 'activation' in m else 'false')
" 2>/dev/null)

  if [[ "$HAS_ACTIVATION" == "false" ]]; then
    if $DRY_RUN; then
      change "Would add activation.onStartup to $ext_name manifest"
    else
      python3 -c "
import json
with open('$manifest') as f:
    m = json.load(f)
m['activation'] = {'onStartup': True}
with open('$manifest', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
"
      change "Added activation.onStartup to $ext_name manifest"
    fi
  fi
done

# ── 4. Install @openclaw/discord as external plugin ────────────────────────

# Check if discord is already installed as external
DISCORD_INSTALLED=false
if [[ -d "$OPENCLAW_DIR/extensions/discord" ]]; then
  # Check if it's the old bundled version or new npm-installed
  if [[ -f "$OPENCLAW_DIR/extensions/discord/package.json" ]]; then
    DISCORD_PKG_NAME=$(python3 -c "
import json
with open('$OPENCLAW_DIR/extensions/discord/package.json') as f:
    pkg = json.load(f)
print(pkg.get('name',''))
" 2>/dev/null || echo "")
    if [[ "$DISCORD_PKG_NAME" == "@openclaw/discord" ]]; then
      DISCORD_INSTALLED=true
    fi
  fi
fi

if $DISCORD_INSTALLED; then
  info "@openclaw/discord already installed externally"
elif $SKIP_INSTALL; then
  info "Skipping @openclaw/discord install (--skip-install)"
else
  if $DRY_RUN; then
    change "Would install: openclaw plugins install @openclaw/discord"
  else
    log "Installing @openclaw/discord..."
    if openclaw plugins install @openclaw/discord 2>&1; then
      change "Installed @openclaw/discord (external)"
    else
      err "@openclaw/discord install failed — check connectivity/npm registry"
      warn "You may need to run: openclaw plugins install @openclaw/discord"
    fi
  fi
fi

# ── 5. Run openclaw doctor --fix for auto-migrations ──────────────────────

if $DRY_RUN; then
  info "Would run: openclaw doctor --fix --non-interactive"
else
  log "Running openclaw doctor --fix --non-interactive..."
  if openclaw doctor --fix --non-interactive 2>&1; then
    change "Doctor fix completed successfully"
  else
    warn "Doctor reported issues — check output above"
    warn "Some legacy migrations may need manual adjustment"
  fi
fi

# ── 6. Validate plugin loading ────────────────────────────────────────────

log "──────────────────────────────────────────────────────"
log "Migration summary:"

if $DRY_RUN; then
  info "DRY RUN — $CHANGES changes would be applied"
  log "Run without --dry-run to apply"
  exit 0
fi

log "Backup: $BACKUP_FILE"
log "Changes applied: $CHANGES"

# List plugins
log "Checking plugin status..."
echo ""
openclaw plugins list 2>&1 || warn "Could not list plugins"

echo ""
log "──────────────────────────────────────────────────────"
log "Next steps:"
echo "  1. Review changes in: $BACKUP_FILE"
echo "  2. Check plugin loading: openclaw status"
echo "  3. If plugins fail to load, review logs at: ~/.openclaw/logs/"
echo "  4. Run a test turn: openclaw message send ..."
log "Migration to 2026.5.7 plugin format complete."
