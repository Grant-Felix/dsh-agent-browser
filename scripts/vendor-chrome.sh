#!/usr/bin/env bash
# Vendor the Chrome-Linux base of this project.
#
#   scripts/vendor-chrome.sh [zip] [--into-data-dir]
#
# Default: extract into <repo>/vendor/chrome-linux/ (gitignored).
# --into-data-dir: extract into ~/.local/share/dsh-agent-browser/chromium/
# instead, which is where the plugin looks when it is installed without the
# repository beside it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP="${1:-/var/home/felix/项目/chrome-linux.zip}"
MODE="${2:-}"

if [[ ! -f "$ZIP" ]]; then
  echo "chrome-linux zip not found: $ZIP" >&2
  echo "usage: $0 [path/to/chrome-linux.zip] [--into-data-dir]" >&2
  exit 1
fi

if [[ "$MODE" == "--into-data-dir" ]]; then
  TARGET="${HOME}/.local/share/dsh-agent-browser"
  mkdir -p "$TARGET"
else
  TARGET="${REPO_ROOT}/vendor"
  mkdir -p "$TARGET"
fi

echo "extracting $(du -h "$ZIP" | cut -f1) from $ZIP"
echo "          into $TARGET"
unzip -q -o "$ZIP" -d "$TARGET"

CHROME="$TARGET/chrome-linux/chrome"
if [[ ! -x "$CHROME" ]]; then
  echo "extraction finished but $CHROME is missing or not executable" >&2
  exit 1
fi

echo "chrome: $("$CHROME" --version 2>/dev/null || echo 'not runnable here')"
echo "done — the plugin resolves this path automatically."
