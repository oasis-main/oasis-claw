#!/bin/sh
# Build "Fleet Observatory.app" (CLAW-126 phase 1) and install it.
#   build.sh <repo> <dest dir>
# `make observatory-app` runs this with the checkout and ~/Applications.
# The app runs `make observatory` in <repo>, so build it from the checkout
# that holds bots/ (the port proxy config), not from a worktree.
set -eu

REPO=$(cd "$1" && pwd)
DEST=$2
NAME="Fleet Observatory"
BUNDLE_ID=com.oasis-x.observatory
SRC="$REPO/scripts/observatory-app"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/observatory-app.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# An app that Finder opens gets PATH=/usr/bin:/bin:/usr/sbin:/sbin. Record
# where node, docker and make are now; build again after one of them moves.
dirs=""
for tool in node docker make; do
  bin=$(command -v "$tool") || { echo "build.sh: $tool is not on PATH" >&2; exit 1; }
  dirs="$dirs:$(dirname "$bin")"
  # docker is a symlink into Docker.app, next to its credential helpers.
  real=$(readlink "$bin" || true)
  case "$real" in /*) dirs="$dirs:$(dirname "$real")" ;; esac
done
APP_PATH=$(printf '%s' "${dirs#:}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  | tr ':' '\n' | awk 'NF && !seen[$0]++' | paste -sd: -)

echo "compiling $NAME"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -framework Cocoa -framework WebKit \
  -o "$APP/Contents/MacOS/$NAME" "$SRC/main.swift"

cp "$SRC/Info.plist" "$APP/Contents/Info.plist"
plutil -replace OASISObservatoryRepo -string "$REPO" "$APP/Contents/Info.plist"
plutil -replace OASISObservatoryPath -string "$APP_PATH" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# The icon is the page's own icon (renderIcon in claw-observatory.mjs).
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
node --input-type=module -e "
  import { renderIcon } from '$REPO/scripts/claw-observatory.mjs';
  process.stdout.write(renderIcon(1024));
" >"$WORK/icon.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad hoc signature with a fixed identifier. macOS keeps the Documents access
# grant for this signature; a new build can ask for it again.
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"

TARGET="$DEST/$NAME.app"
if [ -e "$TARGET" ]; then
  old=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$TARGET/Contents/Info.plist" 2>/dev/null || true)
  if [ "$old" != "$BUNDLE_ID" ]; then
    echo "build.sh: $TARGET exists and is not this app ($old); not replaced" >&2
    exit 1
  fi
  if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
    echo "build.sh: $NAME is running; quit it, then run this again" >&2
    exit 1
  fi
  rm -rf "$TARGET"
fi
mkdir -p "$DEST"
ditto "$APP" "$TARGET"
echo "installed $TARGET"
echo "repo: $REPO"
