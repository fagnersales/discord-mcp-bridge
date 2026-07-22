#!/usr/bin/env bash
set -euo pipefail

guild="${CAPTCHA_GUILD_NAME:-Discord server}"
invite="${CAPTCHA_INVITE:-unknown invite}"
message="Discord is showing a captcha for joining:

${guild}
${invite}

Click the \"I am human\" checkbox in Vesktop/Discord, finish any visible prompt, then press OK here."

if command -v zenity >/dev/null 2>&1; then
  DISPLAY="${DISPLAY:-:0}" zenity \
    --info \
    --title="Discord captcha required" \
    --width=460 \
    --text="$message"
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "Discord captcha required" "Click the I am human checkbox in Vesktop/Discord."
  sleep "${CAPTCHA_WAIT_SECONDS:-90}"
else
  printf '%s\n' "$message" >&2
  sleep "${CAPTCHA_WAIT_SECONDS:-90}"
fi
