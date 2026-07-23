#!/usr/bin/env bash
# Local Linux hotfix build — mirrors .github/workflows/linux-build.yml so the
# artifact has the same known state as CI (fresh-frozen pinned wheel, stamped
# version), but turns around in minutes and costs nothing. For fast iteration
# with Linux testers; release waves still go through CI (all platforms, both
# brands, auto-publish).
#
# Usage: ./scripts/build-linux-local.sh <version> [lib_version] [brand]
#   e.g. ./scripts/build-linux-local.sh 2.2.4-spuds1 2.6.8 litai
#
# The .deb/.rpm land in src-tauri/target/release/bundle/{deb,rpm}/ — send them
# directly to the tester. Local builds NEVER publish to the releases repos.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: build-linux-local.sh <version> [lib_version] [brand]}"
LIB_VERSION="${2:-latest}"
BRAND="${3:-litai}"

echo "=== Local Linux build: brand=$BRAND version=$VERSION wheel=$LIB_VERSION ==="

# --- 1. Native bridge (CI builds Positronic-AI/lit-bridge-rs @ main) ---
BRIDGE_DIR="../lit-bridge-rs"
if [ -n "$(git -C "$BRIDGE_DIR" status --porcelain --untracked-files=no)" ]; then
  echo "!! lit-bridge-rs has uncommitted changes — CI builds from main."
  echo "   Continuing, but the bridge in this build is NOT what CI would ship."
fi
cargo build --release --manifest-path "$BRIDGE_DIR/Cargo.toml"
export LIT_BRIDGE_RS_BUNDLE="$(cd "$BRIDGE_DIR" && pwd)/target/release/lit-bridge-rs"
codesign_skip=true  # linux: no signing step

# --- 2. Freeze the backend from the public wheel (never from local source) ---
FREEZE_VENV="backend/.venv-freeze"
if [ ! -d "$FREEZE_VENV" ]; then python3 -m venv "$FREEZE_VENV"; fi
# shellcheck disable=SC1091
source "$FREEZE_VENV/bin/activate"
pip install -q --upgrade pip pyinstaller
curl -fsSL -o backend/install.py \
  https://github.com/Positronic-AI/lit-releases/releases/latest/download/install.py
pushd backend >/dev/null
if [ "$LIB_VERSION" != "latest" ]; then
  python install.py --version "$LIB_VERSION"
else
  python install.py
fi
FROZEN_VER=$(python -c "import importlib.metadata as m; print(m.version('positronic-lit'))")
echo ">>> freezing positronic-lit $FROZEN_VER"
PYTHONUTF8=1 pyinstaller --noconfirm lit-server.spec
popd >/dev/null
deactivate

# --- 3. Stage the sidecar under the host triple ---
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p src-tauri/binaries
cp backend/dist/lit-server "src-tauri/binaries/lit-server-${TRIPLE}"
chmod +x "src-tauri/binaries/lit-server-${TRIPLE}"
echo ">>> sidecar staged for $TRIPLE (wheel $FROZEN_VER)"

# --- 4. Branded, version-stamped package ---
npm install
LIT_BUILD_VERSION="$VERSION" ./scripts/build-brand.sh "$BRAND"

echo ""
echo "=== Done — artifacts: ==="
find src-tauri/target/release/bundle/deb src-tauri/target/release/bundle/rpm \
  -name '*.deb' -o -name '*.rpm' 2>/dev/null | sed 's/^/  /'
echo ""
echo "Send the .deb directly to the tester. Do NOT upload to the releases repo —"
echo "canonical downloads only ever come from CI."
