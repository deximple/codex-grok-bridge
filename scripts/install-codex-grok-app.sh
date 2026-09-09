#!/bin/sh
# Install or update the bridge inside /Applications/Codex Grok.app.
#
# Default is a JS-only sync: the bundle's scripts/ and src/ are brought in line
# with this checkout, in place. The previous version began with `rm -rf` on the
# directory that CODEX_CLI_PATH points into, which destroys a running app's
# entrypoint; nothing here removes a directory, and stale files are pruned one
# by one only when the repo no longer has them.
#
#   install-codex-grok-app.sh            sync bridge JS (safe, fast)
#   install-codex-grok-app.sh --full     also rebuild the launcher applet and sign
#   install-codex-grok-app.sh --force    proceed even if a Codex Grok window is open
#
# ESM is not hot-reloaded: an open Codex Grok window keeps running the code it
# started with, so restart the window after a sync.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# CODEX_GROK_APP exists so this script can be exercised against a scratch copy
# instead of the installed app.
APP="${CODEX_GROK_APP:-/Applications/Codex Grok.app}"
BRIDGE="$APP/Contents/Resources/bridge"
USER_DATA="$HOME/.local/share/codex-grok-bridge/desktop"

FULL=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$APP/Contents" ]; then
  echo "missing $APP" >&2
  exit 1
fi

if [ "$FORCE" -eq 0 ] && pgrep -f -- "--user-data-dir=$USER_DATA" >/dev/null 2>&1; then
  echo "Codex Grok is running. Close its window first, or pass --force to swap" >&2
  echo "the files under it (the running window keeps its loaded code either way)." >&2
  exit 1
fi

mkdir -p "$BRIDGE/scripts" "$BRIDGE/src"
cp "$ROOT"/scripts/*.mjs "$BRIDGE/scripts/"
cp "$ROOT"/src/*.mjs "$BRIDGE/src/"

# Prune only files this checkout no longer has. Never remove the directory.
for dir in scripts src; do
  for installed in "$BRIDGE/$dir"/*.mjs; do
    [ -e "$installed" ] || continue
    if [ ! -e "$ROOT/$dir/$(basename "$installed")" ]; then
      rm -f "$installed"
      echo "pruned $dir/$(basename "$installed")"
    fi
  done
done

status=0
for dir in scripts src; do
  for source in "$ROOT/$dir"/*.mjs; do
    name="$(basename "$source")"
    if ! cmp -s "$source" "$BRIDGE/$dir/$name"; then
      echo "MISMATCH $dir/$name" >&2
      status=1
    fi
  done
done
[ "$status" -eq 0 ] || { echo "bundle did not match the checkout" >&2; exit 1; }

if [ "$FULL" -eq 1 ]; then
  NODE="${NODE:-$(command -v node || true)}"
  [ -n "$NODE" ] || { echo "no node on PATH; set NODE=/path/to/node" >&2; exit 1; }
  if [ -L "$NODE" ]; then
    NODE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE")"
  fi
  mkdir -p "$APP/Contents/Resources/Scripts"
  LAUNCH="$BRIDGE/scripts/launch-desktop.mjs"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  osacompile -o "$TMP/tmp.app" -e "do shell script \"$NODE \\\"$LAUNCH\\\"\""
  cp "$TMP/tmp.app/Contents/MacOS/applet" "$APP/Contents/MacOS/applet"
  cp "$TMP/tmp.app/Contents/Resources/Scripts/main.scpt" "$APP/Contents/Resources/Scripts/main.scpt"
  chmod +x "$APP/Contents/MacOS/applet"
  xattr -cr "$APP" 2>/dev/null || true
  codesign --force --deep -s - "$APP" >/dev/null
  echo "rebuilt launcher with node $NODE"
fi

echo "bridge in $APP matches $ROOT"
echo "restart any open Codex Grok window to load it"
