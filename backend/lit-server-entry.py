"""PyInstaller entry point — freezes `lit serve --api-only` into a standalone
binary for the lit-desktop sidecar.

The `lit` package is installed from the public pre-built wheel (see the CI
workflows / lit-releases) — this repo carries NO lit-lib source.

Bakes the desktop isolation invariant into the binary: the backend must NEVER
touch a production ~/.lit or ~/.config/lit, so the data/config/runtime dirs
default to a dedicated per-user app-data location. All overridable via env
(the launcher/dev can point elsewhere). With no args it serves the desktop's
loopback API.
"""
import os
import sys

# Windows consoles/pipes default to cp1252, which cannot encode the box-drawing
# and emoji characters in our startup banner and log lines. Without this, the
# first such print raises UnicodeEncodeError and the frozen backend dies before
# it binds its port — surfacing to the user as "Failed to start LIT backend".
# Force UTF-8 (errors="replace" as a belt-and-suspenders) on both streams.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# TLS trust store: a PyInstaller-frozen binary has no access to the system CA
# store, so OpenSSL/aiohttp verification fails with "unable to get local issuer
# certificate". Point the standard env vars at certifi's bundled CA file before
# anything makes an HTTPS call (auth wizards, API backends, etc.).
try:
    import certifi
    _ca = certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", _ca)
    os.environ.setdefault("SSL_CERT_DIR", os.path.dirname(_ca))
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _ca)
    os.environ.setdefault("CURL_CA_BUNDLE", _ca)
except Exception:
    pass

_BASE = os.environ.get(
    "LIT_DESKTOP_HOME",
    os.path.join(os.path.expanduser("~"), ".local", "share", "lit-desktop"),
)
# FORCE (not setdefault): a multi-user server box sets LIT_LOCAL_MODE=false in
# /etc/environment, which every process inherits — so setdefault silently no-ops
# and the desktop backend comes up in MULTI-USER mode. There the channel
# WebSocket (/mux/ws/channel/{id}) demands an auth token the desktop never sends
# and rejects every connection with HTTP 403 → the UI shows "Reconnecting…"
# forever. The desktop is always single-user/local, so force it.
os.environ["LIT_LOCAL_MODE"] = "true"
os.environ.setdefault("LIT_DATA_DIR", os.path.join(_BASE, "data"))
os.environ.setdefault("LIT_CONFIG_DIR", os.path.join(_BASE, "config"))
# Event-signal dir defaults to the server path (/var/lib/lit/events), which a
# desktop user can't write. Keep it inside the sandbox.
os.environ.setdefault("LIT_EVENTS_PATH", os.path.join(_BASE, "events"))
_run = os.path.join(_BASE, "run")
# FORCE (not setdefault): the login session ALWAYS sets XDG_RUNTIME_DIR to the
# shared /run/user/<uid>, so setdefault was a silent no-op. That put the native
# bridge's socket (lit-bridge-rs-<user>.sock, derived from XDG_RUNTIME_DIR) in the
# shared runtime dir, where it collided with any OTHER lit instance running as the
# same OS user — e.g. a dev backend — hijacking bridge sessions and breaking the
# terminal. Forcing an app-private runtime dir gives this app its OWN bridge
# socket, guaranteed unique, so opening the desktop app can never contend.
os.environ["XDG_RUNTIME_DIR"] = _run
for _d in (os.environ["LIT_DATA_DIR"], os.environ["LIT_CONFIG_DIR"],
           os.environ["LIT_EVENTS_PATH"], _run):
    try:
        os.makedirs(_d, exist_ok=True)
    except OSError:
        pass
try:
    os.chmod(_run, 0o700)
except OSError:
    pass

# Reap any native bridge daemon left over from a previous session of THIS app.
# The bridge is intentionally detached (it survives backend restarts), so a hard
# app-close — Tauri SIGKILLs the sidecar, which never propagates to the detached
# grandchild — can leave it running. Harmless now that the socket is app-private,
# but reaping it on startup keeps `ps` clean and guarantees a fresh session.
# STRICTLY scoped to our own runtime dir (_run): the match requires the app-private
# path in the process's cmdline, so it can never touch a dev/other-app bridge.
try:
    import psutil  # bundled in the frozen backend
    for _proc in psutil.process_iter(["cmdline"]):
        try:
            _cl = " ".join(_proc.info.get("cmdline") or [])
            if "lit-bridge" in _cl and _run in _cl:
                _proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
except Exception:
    pass

# Tee stdout/stderr to a log file on disk. The desktop app spawns this backend
# with no visible console, so a startup crash is otherwise invisible — the user
# just sees "Failed to start LIT backend". Writing the full output (banner,
# logs, and any traceback) to a stable path lets the UI point users straight at
# it. Wraps the already-UTF-8-reconfigured streams so it stays crash-proof.
try:
    _log_dir = os.path.join(_BASE, "logs")
    os.makedirs(_log_dir, exist_ok=True)
    _log_fh = open(os.path.join(_log_dir, "backend.log"), "a",
                   encoding="utf-8", errors="replace")

    class _Tee:
        def __init__(self, *streams):
            self._streams = [s for s in streams if s is not None]

        def write(self, data):
            for s in self._streams:
                try:
                    s.write(data)
                    s.flush()
                except Exception:
                    pass
            return len(data)

        def flush(self):
            for s in self._streams:
                try:
                    s.flush()
                except Exception:
                    pass

        def isatty(self):
            return False

    sys.stdout = _Tee(sys.stdout, _log_fh)
    sys.stderr = _Tee(sys.stderr, _log_fh)
except Exception:
    pass

# Native bridge daemon: when frozen, lit-bridge-rs is bundled next to the
# interpreter (see lit-server.spec). Point the claude-interactive backend at it
# so it doesn't fall back to a dev-tree path that only exists on the build box.
if getattr(sys, "frozen", False):
    _rs_name = "lit-bridge-rs.exe" if sys.platform == "win32" else "lit-bridge-rs"
    _rs_path = os.path.join(sys._MEIPASS, _rs_name)
    if os.path.exists(_rs_path):
        if sys.platform != "win32":
            try:
                os.chmod(_rs_path, 0o755)
            except OSError:
                pass
        # Force (not setdefault): the bundled binary is authoritative for a
        # self-contained app. An inherited/stale LIT_BRIDGE_RS_BIN from the
        # launching environment could otherwise point at a dev-tree path that
        # doesn't exist on the target machine — the exact failure we're fixing.
        os.environ["LIT_BRIDGE_RS_BIN"] = _rs_path

from lit.bin import main

if __name__ == "__main__":
    if len(sys.argv) == 1:
        sys.argv += ["serve", "--api-only", "--host", "127.0.0.1", "--port", "5000"]
    sys.exit(main())
