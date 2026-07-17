#!/usr/bin/env bash
# Dev launcher for LIT Desktop.
#
# Why this exists: `tauri dev` loads the frontend from the Vite dev server on
# :1420. If a previous run left a stale app window or a dead/zombie Vite behind,
# the new run can silently attach to nothing and you end up staring at a cached
# page — edits appear to "do nothing". This clears the decks first, then launches.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Clearing any stale dev processes…"
pkill -f "src-tauri/target/debug/lit-server" 2>/dev/null || true
pkill -f "node_modules/.bin/vite"            2>/dev/null || true
sleep 0.5

if ss -ltn 2>/dev/null | grep -q ':1420 '; then
  echo "!! Port 1420 is still held after cleanup. Something else owns it:"
  ss -ltnp 2>/dev/null | grep ':1420 ' || true
  echo "   Free it, then re-run. Aborting."
  exit 1
fi
echo "==> Port 1420 free."

echo "==> Launching (watch for 'VITE ready' + 'Local: http://localhost:1420/')…"
exec npm run tauri dev
