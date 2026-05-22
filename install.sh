#!/usr/bin/env bash
# Install the discord-mcp-bridge: bun deps + symlink the debugBridge userplugin
# into a Vencord checkout.
# Usage: ./install.sh [path-to-Vencord]   (default: ~/Vencord)
set -euo pipefail

VENCORD="${1:-$HOME/Vencord}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$VENCORD/src/userplugins"

if [ ! -d "$DEST" ]; then
    echo "Vencord userplugins dir not found: $DEST"
    echo "Usage: ./install.sh [path-to-Vencord]"
    exit 1
fi

echo "Installing Bun dependencies ..."
( cd "$SRC" && bun install )

ln -sfn "$SRC/debugBridge" "$DEST/debugBridge"
echo "linked  debugBridge -> $DEST/debugBridge"

echo
echo "Next:"
echo "  1. Register the MCP server with Claude Code, then restart it:"
echo "       claude mcp add discord-bridge -s user -- \"\$(which bun)\" \"$SRC/server.ts\""
echo "  2. Build & deploy Vencord, enable the DebugBridge plugin, press Ctrl+R."
