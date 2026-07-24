#!/usr/bin/env bash
# Dev launcher for LIT Desktop.
#
# Why this exists: `tauri dev` loads the frontend from the Vite dev server on
# :1420. If a previous run left a stale app window or a dead/zombie Vite behind,
# the new run can silently attach to nothing and you end up staring at a cached
# page — edits appear to "do nothing". This clears the decks first, then launches.
#
# It also starts the backend FROM SOURCE (lit-lib dev venv + dev-built bridge)
# on 127.0.0.1:5000 before launching. startBackend() in the app probes that
# port first and skips spawning the frozen sidecar when it answers — so dev
# mode runs the most current bits on BOTH sides, not dev frontend + last
# week's frozen wheel. The env below mirrors lit-server-entry.py's isolation
# invariant: everything lives under ~/.local/share/lit-desktop, and the
# app-private XDG_RUNTIME_DIR keeps the bridge socket from colliding with any
# other lit instance running as this OS user.
set -euo pipefail
cd "$(dirname "$0")"

BASE="$HOME/.local/share/lit-desktop"
LIT_BIN="/opt/lit-platform/lit-lib/.venv/bin/lit"
BRIDGE_BIN="/opt/lit-platform/lit-bridge-rs/target/release/lit-bridge-rs"

echo "==> Clearing any stale dev processes…"
pkill -f "src-tauri/target/debug/lit-server" 2>/dev/null || true
pkill -f "node_modules/.bin/vite"            2>/dev/null || true
# Previous source-mode backend, and this app's detached bridge daemon. The
# bridge match is scoped to $BASE/run so it can never touch another instance.
pkill -f "lit serve --api-only --host 127.0.0.1 --port 5000" 2>/dev/null || true
pkill -f "$BASE/run" 2>/dev/null || true
sleep 0.5

if ss -ltn 2>/dev/null | grep -q ':1420 '; then
  echo "!! Port 1420 is still held after cleanup. Something else owns it:"
  ss -ltnp 2>/dev/null | grep ':1420 ' || true
  echo "   Free it, then re-run. Aborting."
  exit 1
fi
echo "==> Port 1420 free."

# Port 5000 is the desktop backend's port, dev or installed. If the INSTALLED
# app's frozen sidecar holds it (left open from normal use), reclaim it — the
# dev backend owns this port for the session. Anything that isn't a lit-server
# sidecar is a genuine conflict: abort and let the human decide.
if ss -ltn 2>/dev/null | grep -q ':5000 '; then
  holder_pids=$(ss -ltnp 2>/dev/null | grep ':5000 ' | grep -oP 'pid=\K[0-9]+' | sort -u)
  for pid in $holder_pids; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$comm" in
      lit-server|jovai-server)
        echo "==> Port 5000 held by installed sidecar ($comm pid=$pid) — reclaiming it."
        echo "    (If the installed desktop app is open, close its window — its backend is gone.)"
        kill "$pid" 2>/dev/null || true
        ;;
      *)
        echo "!! Port 5000 is held by a non-sidecar process ($comm pid=$pid):"
        ss -ltnp 2>/dev/null | grep ':5000 ' || true
        echo "   Free it, then re-run. Aborting."
        exit 1
        ;;
    esac
  done
  for i in $(seq 1 10); do
    ss -ltn 2>/dev/null | grep -q ':5000 ' || break
    [ "$i" -eq 10 ] && { echo "!! Port 5000 still held after kill. Aborting."; exit 1; }
    sleep 0.5
  done
fi

echo "==> Starting backend from source ($LIT_BIN)…"
mkdir -p "$BASE/data" "$BASE/config" "$BASE/events" "$BASE/run" "$BASE/logs"
chmod 700 "$BASE/run"
(
  export LIT_LOCAL_MODE=true
  export LIT_DATA_DIR="$BASE/data"
  export LIT_CONFIG_DIR="$BASE/config"
  export LIT_EVENTS_PATH="$BASE/events"
  export XDG_RUNTIME_DIR="$BASE/run"
  export LIT_BRIDGE_RS_BIN="$BRIDGE_BIN"
  exec "$LIT_BIN" serve --api-only --host 127.0.0.1 --port 5000
) >> "$BASE/logs/backend.log" 2>&1 &
BACKEND_PID=$!
# Parity with the frozen sidecar: the backend dies when the launcher exits.
trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:5000/mux/agents" 2>/dev/null; then
    echo "==> Backend ready on 127.0.0.1:5000 (source build)."
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "!! Backend process died on startup — tail of $BASE/logs/backend.log:"
    tail -20 "$BASE/logs/backend.log" || true
    exit 1
  fi
  if [ "$i" -eq 30 ]; then
    echo "!! Backend didn't come up in 30s — see $BASE/logs/backend.log"
    exit 1
  fi
  sleep 1
done

echo "==> Launching (watch for 'VITE ready' + 'Local: http://localhost:1420/')…"
npm run tauri dev
