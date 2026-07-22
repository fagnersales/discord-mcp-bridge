#!/usr/bin/env bash
# Install the discord-mcp-bridge: bun deps + copy the discordMcp userplugin
# into a Vencord checkout.
# Usage: ./install.sh [path-to-Vencord]   (default: ~/Vencord)
set -euo pipefail

VENCORD="${1:-$HOME/Vencord}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$VENCORD/src/userplugins"

if [ ! -d "$VENCORD/src" ]; then
    echo "Vencord src dir not found: $VENCORD/src"
    echo "Usage: ./install.sh [path-to-Vencord]"
    exit 1
fi
mkdir -p "$DEST"

echo "Installing Bun dependencies ..."
( cd "$SRC" && bun install )

# Remove the old debugBridge symlink from before the plugin was renamed, so
# Vencord does not register two copies of the plugin under different names.
if [ -L "$DEST/debugBridge" ]; then
    rm "$DEST/debugBridge"
    echo "removed legacy symlink $DEST/debugBridge"
fi

PLUGIN_DEST="$DEST/discordMcp"
if [ -L "$PLUGIN_DEST" ]; then
    rm "$PLUGIN_DEST"
fi
if [ -e "$PLUGIN_DEST" ] && [ ! -d "$PLUGIN_DEST" ]; then
    echo "Cannot install: $PLUGIN_DEST exists and is not a directory"
    exit 1
fi

# Do not symlink this folder. esbuild follows symlinks to their real path, and
# then Vencord's tsconfig aliases (@api, @utils, @webpack, etc.) no longer
# resolve because the plugin source appears outside the Vencord tree.
mkdir -p "$PLUGIN_DEST"
cp "$SRC/discordMcp/index.tsx" "$SRC/discordMcp/native.ts" "$PLUGIN_DEST/"
echo "copied  discordMcp -> $PLUGIN_DEST"

echo
echo "Next:"
echo "  1. Register the MCP server with Claude Code, then restart it:"
echo "       claude mcp add discord-bridge -s user -- \"\$(which bun)\" \"$SRC/server.ts\""
echo "  2. Build & deploy Vencord, enable the DiscordMCP plugin, press Ctrl+R."
echo "     Re-run this installer after editing discordMcp/*.ts(x), then rebuild."
