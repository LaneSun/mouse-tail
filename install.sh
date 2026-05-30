#!/usr/bin/env bash
#
# Mouse Tail - one-line installer
#
# Usage (install the latest version):
#   curl -fsSL https://raw.githubusercontent.com/LaneSun/mouse-tail/main/install.sh | bash
#
# Optional environment variables:
#   BRANCH=dev   install a specific branch (default: main)
#
set -euo pipefail

REPO_URL="https://github.com/LaneSun/mouse-tail.git"
BRANCH="${BRANCH:-main}"

info()  { printf '\033[1;34m[*]\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m[+]\033[0m %s\n' "$1"; }
err()   { printf '\033[1;31m[!]\033[0m %s\n' "$1" >&2; }

# Check dependencies
for cmd in git glib-compile-schemas; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Missing dependency: $cmd. Please install it and try again."
    exit 1
  fi
done

# Clone into a temp dir and only swap it into place on success,
# so a mid-install failure never leaves a broken extension behind.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Cloning from repository (branch: $BRANCH)..."
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/src"

# Read the UUID from metadata.json instead of hard-coding it
UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/src/metadata.json")"
if [ -z "$UUID" ]; then
  err "Could not parse UUID from metadata.json."
  exit 1
fi
info "Extension UUID: $UUID"

# Compile the GSettings schema (the repo does not ship the compiled
# artifact, so this is required or the extension will fail to load).
info "Compiling settings schema..."
glib-compile-schemas "$TMP_DIR/src/schemas"

# Swap into the install location
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
info "Installing to: $TARGET_DIR"
mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$TARGET_DIR"
mv "$TMP_DIR/src" "$TARGET_DIR"

# Try to enable it (a fresh install may require reloading the shell first)
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" 2>/dev/null || true
fi

ok "Installation complete!"
echo
echo "  On Wayland the GNOME Shell cannot be restarted in place, so please LOG OUT and LOG BACK IN to load the new version."
echo "  (On X11 you can restart the shell with Alt+F2, then type r.)"
echo "  If it is not enabled automatically after login, run: gnome-extensions enable $UUID"
