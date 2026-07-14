#!/bin/bash
# Build a white-labeled LIT Desktop.  Usage: scripts/build-brand.sh [litai|jovai]
#
# Applies the brand's full identity so builds install SIDE BY SIDE (no clobber):
#   productName    -> deb/rpm package name + .desktop Name
#   identifier     -> app id
#   mainBinaryName -> the app executable (/usr/bin/<name>)
#   externalBin    -> the sidecar executable (/usr/bin/<sidecar>)
#   window title + VITE_LIT_BRAND -> in-app branding
# tauri.conf.json is restored afterward.
set -e
BRAND="${1:-litai}"
cd "$(dirname "$0")/.."
CONF="src-tauri/tauri.conf.json"

# Host target triple (Tauri names sidecars <name>-<triple>). Works on any OS.
TRIPLE="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"
[ -z "$TRIPLE" ] && { echo "could not detect rust host triple (is rustc installed?)"; exit 1; }
EXE=""; case "$TRIPLE" in *windows*) EXE=".exe";; esac
# Per-OS bundle targets (skip Linux AppImage — needs linuxdeploy + FUSE and adds nothing over deb/rpm).
case "$TRIPLE" in
  *linux*)   TARGETS='["deb","rpm"]' ;;
  *darwin*)  TARGETS='["dmg","app"]' ;;
  *windows*) TARGETS='["msi","nsis"]' ;;
  *)         TARGETS='["deb"]' ;;
esac
# Ad-hoc code signing on macOS: Apple Silicon refuses to run unsigned executables,
# so ad-hoc sign both the sidecar and the app bundle. (Full Developer ID signing +
# notarization comes later, once a cert is available.)
SIGNID=""; case "$TRIPLE" in *darwin*) SIGNID="-";; esac

case "$BRAND" in
  jovai) PRODUCT="JovAI";       ID="ai.jov.desktop"; TITLE="JovAI"; MAINBIN="jovai";       SIDECAR="jovai-server"; ICONDIR="icons-jovai" ;;
  litai) PRODUCT="LIT Desktop"; ID="ai.lit.desktop"; TITLE="LIT";   MAINBIN="lit-desktop"; SIDECAR="lit-server";   ICONDIR="icons" ;;
  *) echo "unknown brand: $BRAND (expected litai|jovai)"; exit 1 ;;
esac

# The frozen backend is built once as lit-server-<triple>; give the brand its own
# copy so the two installs don't fight over /usr/bin/<sidecar>.
SRC="src-tauri/binaries/lit-server-${TRIPLE}${EXE}"
DEST="src-tauri/binaries/${SIDECAR}-${TRIPLE}${EXE}"
[ -f "$SRC" ] || { echo "missing sidecar binary: $SRC (build it with PyInstaller first)"; exit 1; }
if [ "$DEST" != "$SRC" ]; then cp "$SRC" "$DEST" && chmod +x "$DEST"; fi
# Ad-hoc sign the sidecar so the app can spawn it on Apple Silicon.
if [ -n "$SIGNID" ]; then codesign --force --sign - "$DEST" && echo "ad-hoc signed sidecar: $DEST"; fi

cp "$CONF" "$CONF.bak"
trap 'mv "$CONF.bak" "$CONF"' EXIT

# Optional version override (CI passes an incrementing build version here).
VERSION="${LIT_BUILD_VERSION:-}"
python3 - "$CONF" "$PRODUCT" "$ID" "$TITLE" "$MAINBIN" "$SIDECAR" "$ICONDIR" "$TARGETS" "$SIGNID" "$VERSION" <<'PY'
import json, sys
conf, product, ident, title, mainbin, sidecar, icondir, targets, signid, version = sys.argv[1:11]
d = json.load(open(conf))
d["productName"] = product
d["identifier"] = ident
d["mainBinaryName"] = mainbin
if version:
    d["version"] = version
d["app"]["windows"][0]["title"] = title
d["bundle"]["externalBin"] = [f"binaries/{sidecar}"]
d["bundle"]["targets"] = json.loads(targets)
d["bundle"]["icon"] = [
    f"{icondir}/32x32.png",
    f"{icondir}/128x128.png",
    f"{icondir}/128x128@2x.png",
    f"{icondir}/icon.icns",
    f"{icondir}/icon.ico",
]
if signid:
    # Ad-hoc sign the whole bundle (covers nested binaries too).
    d["bundle"].setdefault("macOS", {})["signingIdentity"] = signid
json.dump(d, open(conf, "w"), indent=2)
PY
echo ">>> version=${VERSION:-$(python3 -c "import json;print(json.load(open('$CONF'))['version'])")}"

echo ">>> building brand=$BRAND product='$PRODUCT' id=$ID bin=$MAINBIN sidecar=$SIDECAR triple=$TRIPLE"
VITE_LIT_BRAND="$BRAND" npm run tauri build
