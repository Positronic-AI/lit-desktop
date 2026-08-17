#!/usr/bin/env python3
"""A fake STALE sidecar for QA'ing the adopt-case handshake.

Reproduces Lais's 2026-08-17 incident shape: a healthy-looking backend on
:5000 whose /mux/health reports NO version (pre-2.6.16 = stale by definition).

Run it, then start the app with enforcement on (dev builds don't enforce
unless you bake a version):

    # Terminal 1 — the impostor. Its PROCESS NAME starts with "lit-server",
    # so the handshake should identify it as ours and reap it:
    python3 scripts/qa-stale-backend.py

    # Terminal 2 — the app, with a bundled-version stamp:
    VITE_LIB_VERSION=9.9.9 npm run tauri dev

Expected: the app logs the version mismatch, the Rust side logs
"[adopt] reaping stale sidecar lit-server-fake…", this process dies, and the
app spawns the real staged sidecar.

Negative test (must be SPARED): run with --plain so the process stays named
python3 — the app must log "not ours — leaving it" and keep using it.
"""

import http.server
import json
import os
import shutil
import sys
import tempfile

PORT = int(os.environ.get("QA_PORT", "5000"))


def serve():
    # Refuse loudly if something real is already on the port — the QA
    # procedure requires a FREE :5000 (stop your dev backend first). Never
    # kill-by-port to make room; that is the exact mistake this fix guards
    # against (and the mistake that killed Ben's dev sidecar on 2026-08-17).
    import socket
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", PORT))
        probe.close()
    except OSError:
        sys.exit(f"[fake-stale] :{PORT} is already in use — stop the real "
                 f"backend first (do NOT kill-by-port; check what it is).")

    class Handler(http.server.BaseHTTPRequestHandler):
        # The app probes the LOCAL backend through the webview's fetch
        # (api.ts hostFetch), so CORS applies: without these headers every
        # probe is blocked by the browser, checkConnection() fails, and the
        # adopt branch under test is never reached (found the hard way,
        # 2026-08-17 — the "stuck at Starting the local backend" QA run).
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "*")
            self.send_header("Access-Control-Allow-Headers", "*")

        def do_OPTIONS(self):  # noqa: N802 — preflight
            self.send_response(200)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            # /mux/agents satisfies the app's health probe; /mux/health has
            # deliberately NO "version" — the stale signature.
            body = b"[]" if "agents" in self.path else json.dumps(
                {"status": "healthy"}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            print(f"[fake-stale] {fmt % args}")

    print(f"[fake-stale] serving on :{PORT} as {os.path.basename(sys.executable)}")
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    if "--serve" in sys.argv or "--plain" in sys.argv:
        serve()
    else:
        # Re-exec under an interpreter copy NAMED lit-server-fake so the
        # process image matches the sidecar prefix the reaper looks for.
        d = tempfile.mkdtemp(prefix="qa-stale-")
        fake = os.path.join(d, "lit-server-fake")
        shutil.copy2(sys.executable, fake)
        os.execv(fake, [fake, os.path.abspath(__file__), "--serve"])
