#!/bin/sh
# Install or update the dedicated Codex Grok desktop wrapper.
#
# macOS: sync JS into /Applications/Codex Grok.app (must already exist).
# Linux: create ~/.local/share/codex-grok-bridge/app and a user .desktop.
# Never writes /Applications/Codex.app or /usr/lib/chatgpt.
#
#   install-codex-grok-app.sh            sync bridge JS (safe, fast)
#   install-codex-grok-app.sh --full     macOS: rebuild applet; Linux: rewrite launcher
#   install-codex-grok-app.sh --force    proceed even if a Codex Grok window is open
#
# ESM is not hot-reloaded: an open Codex Grok window keeps running the code it
# started with, so restart the window after a sync.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
USER_DATA="$HOME/.local/share/codex-grok-bridge/desktop"
PLATFORM="${CODEX_GROK_PLATFORM:-$(uname -s)}"
case "$PLATFORM" in
  Linux|linux) PLATFORM=linux ;;
  Darwin|darwin) PLATFORM=darwin ;;
esac

if [ "$PLATFORM" = linux ]; then
  APP="${CODEX_GROK_APP:-$HOME/.local/share/codex-grok-bridge/app}"
  BRIDGE="$APP"
else
  APP="${CODEX_GROK_APP:-/Applications/Codex Grok.app}"
  BRIDGE="$APP/Contents/Resources/bridge"
fi

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

case "$APP" in
  /usr/lib/chatgpt|/usr/lib/chatgpt/*|/usr/bin/chatgpt|/Applications/Codex.app|/Applications/Codex.app/*)
    echo "refusing to install into the stock ChatGPT/Codex prefix: $APP" >&2
    exit 1
    ;;
esac

if [ "$PLATFORM" != linux ] && [ ! -d "$APP/Contents" ]; then
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

write_linux_wrapper() {
  NODE="${NODE:-$(command -v node || true)}"
  [ -n "$NODE" ] || { echo "no node on PATH; set NODE=/path/to/node" >&2; exit 1; }
  if [ -L "$NODE" ]; then
    NODE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE")"
  fi
  mkdir -p "$APP/bin"
  LAUNCHER="$APP/bin/codex-grok-desktop"
  NODE_Q=$(printf "%s" "$NODE" | sed "s/'/'\\\\''/g")
  cat > "$LAUNCHER" <<EOF
#!/bin/sh
set -eu
ROOT="\$(CDPATH= cd -- "\$(dirname "\$0")/.." && pwd)"
exec '$NODE_Q' "\$ROOT/scripts/launch-desktop.mjs" "\$@"
EOF
  chmod +x "$LAUNCHER"
  APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS_DIR"
  DESKTOP="$APPS_DIR/codex-grok.desktop"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Codex Grok
Comment=Codex desktop with Grok via the local bridge
Exec="$LAUNCHER" %U
Icon=chatgpt
Terminal=false
Categories=Development;
StartupWMClass=ChatGPT
EOF
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  echo "linux wrapper $LAUNCHER"
  echo "desktop entry $DESKTOP"
}

if [ "$PLATFORM" = linux ]; then
  write_linux_wrapper
elif [ "$FULL" -eq 1 ]; then
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
