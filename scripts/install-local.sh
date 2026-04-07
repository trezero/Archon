#!/usr/bin/env bash
# scripts/install-local.sh
# LOCAL TEST harness for install.sh — installs from a file on disk instead of
# downloading from GitHub Releases. Used to validate the install flow against
# a binary built from the current branch before cutting a release.
#
# Usage:
#   # On your dev machine, cross-compile for linux:
#   bun build --compile --target=bun-linux-x64 --outfile dist/archon-linux-x64 packages/cli/src/cli.ts
#   scp dist/archon-linux-x64 user@vm:/tmp/archon-linux-x64
#   scp scripts/install-local.sh user@vm:/tmp/install-local.sh
#
#   # On the Linux VM:
#   LOCAL_BINARY=/tmp/archon-linux-x64 bash /tmp/install-local.sh
#
# Options (env vars):
#   LOCAL_BINARY  - Path to local binary (REQUIRED)
#   INSTALL_DIR   - Install dir (default: /usr/local/bin, falls back to ~/.local/bin if not writable)
#   SKIP_SUDO     - Set to "true" to never use sudo (force ~/.local/bin)

set -euo pipefail

LOCAL_BINARY="${LOCAL_BINARY:-}"
INSTALL_DIR="${INSTALL_DIR:-}"
SKIP_SUDO="${SKIP_SUDO:-false}"
BINARY_NAME="archon"

c_info()  { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
c_ok()    { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
c_warn()  { printf '\033[33m[WARN]\033[0m  %s\n' "$*"; }
c_err()   { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }

echo
echo "  +---------------------------------------+"
echo "  |   Archon CLI Installer (LOCAL TEST)   |"
echo "  +---------------------------------------+"
echo

# --- Locate local binary ---
if [[ -z "$LOCAL_BINARY" ]]; then
  c_err "LOCAL_BINARY env var is required"
  c_err "  Example: LOCAL_BINARY=/tmp/archon-linux-x64 bash $0"
  exit 1
fi
if [[ ! -f "$LOCAL_BINARY" ]]; then
  c_err "Local binary not found: $LOCAL_BINARY"
  exit 1
fi

size=$(stat -c%s "$LOCAL_BINARY" 2>/dev/null || stat -f%z "$LOCAL_BINARY")
c_ok "Found local binary: $LOCAL_BINARY ($size bytes)"

# --- SHA256 (informational) ---
if command -v sha256sum >/dev/null 2>&1; then
  hash=$(sha256sum "$LOCAL_BINARY" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  hash=$(shasum -a 256 "$LOCAL_BINARY" | awk '{print $1}')
else
  hash="(no sha256 tool available)"
fi
c_info "SHA256: $hash"

# --- Pick install dir ---
if [[ -z "$INSTALL_DIR" ]]; then
  if [[ "$SKIP_SUDO" == "true" ]]; then
    INSTALL_DIR="$HOME/.local/bin"
  elif [[ -w "/usr/local/bin" ]]; then
    INSTALL_DIR="/usr/local/bin"
  elif command -v sudo >/dev/null 2>&1; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
  fi
fi
c_info "Install dir: $INSTALL_DIR"

# --- Create install dir ---
SUDO=""
if [[ ! -w "$(dirname "$INSTALL_DIR/.")" ]] && [[ "$SKIP_SUDO" != "true" ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    c_info "Will use sudo to write to $INSTALL_DIR"
  fi
fi
$SUDO mkdir -p "$INSTALL_DIR"

# --- Copy binary ---
DEST="$INSTALL_DIR/$BINARY_NAME"
c_info "Installing to $DEST..."
$SUDO cp "$LOCAL_BINARY" "$DEST"
$SUDO chmod +x "$DEST"
c_ok "Installed to $DEST"

# --- PATH hint ---
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *)
    c_warn "$INSTALL_DIR is NOT in your PATH"
    c_warn "Add this to ~/.bashrc or ~/.zshrc:"
    c_warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

# --- Verify ---
echo
c_info "Verifying installation (running '$DEST version')..."
if "$DEST" version; then
  c_ok "Installation complete!"
else
  c_err "Binary failed to run (exit $?)"
  exit 1
fi

echo
echo "  Cleanup when done testing:"
echo "    $SUDO rm -f $DEST"
echo
