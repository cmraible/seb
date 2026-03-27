#!/bin/bash
# Install logdy binary for log viewing
# Usage: ./scripts/install-logdy.sh [version]

set -euo pipefail

VERSION="${1:-0.13.0}"
INSTALL_DIR="${HOME}/.local/bin"
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

OS=$(uname -s | tr '[:upper:]' '[:lower:]')

URL="https://github.com/logdyhq/logdy-core/releases/download/v${VERSION}/logdy_${OS}_${ARCH}"

mkdir -p "$INSTALL_DIR"

echo "Downloading logdy v${VERSION} for ${OS}/${ARCH}..."
curl -fsSL "$URL" -o "${INSTALL_DIR}/logdy"
chmod +x "${INSTALL_DIR}/logdy"

echo "Installed logdy to ${INSTALL_DIR}/logdy"
"${INSTALL_DIR}/logdy" --version || true
