#!/bin/sh
# Double-click to open the dedicated Codex window with Grok 4.6 available.
# Resolves everything from this file's own location, so the checkout can live
# anywhere and be moved without editing this launcher.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(command -v node || true)}"
[ -n "$NODE" ] || { echo "no node on PATH; set NODE=/path/to/node" >&2; exit 1; }
exec "$NODE" "$ROOT/scripts/launch-desktop.mjs"
