#!/usr/bin/env bash
# Vendor the Firefox base of this project.
#
#   scripts/vendor-firefox.sh [tarball] [--into-data-dir]
#
# Default: extract into <repo>/vendor/firefox/ (gitignored).
# --into-data-dir: extract into ~/.local/share/dsh-agent-browser/firefox/
# instead, which is where the plugin looks when it is installed without the
# repository beside it.
#
# The project was developed against Mozilla Firefox 157. Any recent build with
# WebDriver BiDi (`--remote-debugging-port` opening ws://…/session) works; the
# backend never uses Firefox's CDP, because this build has none.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${1:-}"
MODE="${2:-}"

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "firefox tarball not found: ${ARCHIVE:-<none>}" >&2
  echo "usage: $0 path/to/firefox-<version>.tar.xz [--into-data-dir]" >&2
  echo "  get it from https://www.mozilla.org/firefox/download/thanks/ (linux-x86_64 tarball)" >&2
  exit 1
fi

if [[ "$MODE" == "--into-data-dir" ]]; then
  TARGET="${HOME}/.local/share/dsh-agent-browser"
  mkdir -p "$TARGET"
else
  TARGET="${REPO_ROOT}/vendor"
  mkdir -p "$TARGET"
fi

echo "extracting $(du -h "$ARCHIVE" | cut -f1) from $ARCHIVE"
echo "          into $TARGET"
# Mozilla ships .tar.xz; accept .tar.bz2/.tar.gz too.
tar -xf "$ARCHIVE" -C "$TARGET"

BIN="$TARGET/firefox/firefox"
if [[ ! -x "$BIN" ]]; then
  echo "extraction finished but $BIN is missing or not executable" >&2
  exit 1
fi

echo "firefox: $("$BIN" --version 2>/dev/null || echo 'not runnable here')"
echo "done — the plugin resolves this path automatically (config: firefoxPath)."
