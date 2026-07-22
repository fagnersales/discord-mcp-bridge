#!/usr/bin/env bash
# Build a Vencord checkout with only the DiscordMCP userplugin included.
#
# Vencord builds every folder in src/userplugins. This helper keeps unrelated
# userplugins out of the generated dist without deleting them from the checkout.
# Usage: ./build-vencord-discordmcp-only.sh [path-to-Vencord]   (default: ~/Vencord)
set -euo pipefail

VENCORD="${1:-$HOME/Vencord}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERPLUGINS="$VENCORD/src/userplugins"

if [ ! -d "$VENCORD/src" ]; then
    echo "Vencord src dir not found: $VENCORD/src"
    echo "Usage: ./build-vencord-discordmcp-only.sh [path-to-Vencord]"
    exit 1
fi

mkdir -p "$USERPLUGINS"

"$SRC/install.sh" "$VENCORD"

STASH_DIR="$VENCORD/.discord-mcp-bridge-userplugins-stash"
if [ -e "$STASH_DIR" ]; then
    echo "Refusing to continue: stash directory already exists: $STASH_DIR"
    echo "Move or restore it first."
    exit 1
fi

restore_userplugins() {
    if [ -d "$STASH_DIR" ]; then
        shopt -s nullglob dotglob
        for entry in "$STASH_DIR"/*; do
            mv "$entry" "$USERPLUGINS/"
        done
        rmdir "$STASH_DIR"
    fi
}
trap restore_userplugins EXIT INT TERM

mkdir "$STASH_DIR"
shopt -s nullglob dotglob
for entry in "$USERPLUGINS"/*; do
    [ "$(basename "$entry")" = "discordMcp" ] && continue
    mv "$entry" "$STASH_DIR/"
done

( cd "$VENCORD" && node scripts/build/build.mjs --standalone )
