#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Synctx — One-Line Installer (macOS / Linux)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/adsathye/synctx/main/setup.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="adsathye/synctx"
INSTALL_DIR="${HOME}/.synctx-plugin"

echo ""
echo "  Synctx — Installer"
echo ""

# ── Auto-Install Prerequisites ───────────────────────────────────────────────

ALL_OK=true

check_or_install() {
  local cmd="$1" brew_pkg="$2" label="$3"
  printf "\r  \033[36m*\033[0m Checking %s...                              " "$label"
  if command -v "$cmd" &>/dev/null; then
    return 0
  fi

  printf "\r  \033[36m*\033[0m Installing %s...                            " "$label"
  if command -v brew &>/dev/null; then
    brew install "$brew_pkg" &>/dev/null
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y "$brew_pkg" &>/dev/null
  else
    ALL_OK=false
    return 1
  fi

  command -v "$cmd" &>/dev/null
}

printf "  \033[36m*\033[0m Checking prerequisites..."

# Node.js
printf "\r  \033[36m*\033[0m Checking Node.js...                           "
if ! command -v node &>/dev/null; then
  printf "\r  \033[36m*\033[0m Installing Node.js...                        "
  if command -v brew &>/dev/null; then
    brew install node &>/dev/null
  elif command -v nvm &>/dev/null; then
    nvm install --lts &>/dev/null
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x 2>/dev/null | sudo -E bash - &>/dev/null
    sudo apt-get install -y nodejs &>/dev/null
  fi
fi

check_or_install "git" "git" "Git"
check_or_install "gh" "gh" "GitHub CLI"
check_or_install "gitleaks" "gitleaks" "Gitleaks"

# Copilot CLI
printf "\r  \033[36m*\033[0m Checking Copilot CLI...                       "
if ! command -v copilot &>/dev/null; then
  printf "\r  \033[36m*\033[0m Installing Copilot CLI...                    "
  curl -fsSL https://gh.io/copilot-install 2>/dev/null | bash &>/dev/null || true
fi

if $ALL_OK && command -v node &>/dev/null; then
  printf "\r  \033[32m✓\033[0m All prerequisites ready                     \n"
else
  printf "\r  \033[33m!\033[0m Some prerequisites need attention            \n"
fi

# Final check
if ! command -v node &>/dev/null; then
  echo ""
  echo "  [error] Node.js is still not available."
  echo "     Install from https://nodejs.org/ and re-run this script."
  exit 1
fi

echo ""

# ── Clone or Update ──────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  printf "  \033[36m*\033[0m Updating Synctx..."
  git -C "$INSTALL_DIR" fetch --quiet origin main 2>/dev/null
  git -C "$INSTALL_DIR" reset --quiet --hard origin/main 2>/dev/null
  printf "\r  \033[32m✓\033[0m Updated to latest          \n"
else
  printf "  \033[36m⠋\033[0m Downloading Synctx..."
  git clone --quiet "https://github.com/${REPO}.git" "$INSTALL_DIR" 2>/dev/null
  printf "\r  \033[32m✓\033[0m Downloaded                 \n"
fi

# ── Install ──────────────────────────────────────────────────────────────────

echo ""
node "${INSTALL_DIR}/install.js"

echo ""
echo "  ─────────────────────────────────────────────"
echo "  Synctx installed successfully!"
echo ""
echo "  Quick start:"
echo "    synctx list                          # See your sessions"
echo "    synctx tag <session-id> my-feature   # Tag a session"
echo "    synctx restore my-feature            # Restore on any machine"
echo ""
echo "  Sessions sync automatically in the background."
echo "  Use /synctx commands inside Copilot CLI."
echo ""
echo "  To update:  re-run this script"
echo "  To remove:  synctx uninstall"
echo "  ─────────────────────────────────────────────"
echo ""
