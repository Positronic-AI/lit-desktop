# LIT Desktop

The native desktop shell for LIT — a **collaboration cockpit** for Ben + Claude.
Tauri v2 (Rust) wrapping a vanilla-TS/Vite frontend, with the full LIT platform
running as a **frozen Python sidecar** so the app is self-contained (no system
Python, no `pip install`).

## Architecture

```
┌─ Tauri (Rust shell) ──────────────────────────────────────┐
│  src-tauri/                                                │
│    tauri.conf.json   beforeDevCommand: npm run dev (Vite)  │
│                      devUrl: http://localhost:1420         │
│                      externalBin: binaries/lit-server-…    │
│                                                            │
│  ┌─ Frontend (Vite, vanilla TS) ─┐  ┌─ Sidecar (frozen) ─┐ │
│  │  src/main.ts   app bootstrap  │  │  lit serve         │ │
│  │  src/window-manager.ts        │  │  --api-only        │ │
│  │    dockview-core docking      │→ │  (PyInstaller of   │ │
│  │  src/panel-host.ts            │  │   backend/lit-     │ │
│  │  src/styles.css               │  │   server-entry.py) │ │
│  └───────────────────────────────┘  └────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

The frontend talks to the sidecar's local FastAPI over HTTP (same `/api`,
`/mux`, `/v1` endpoints as the webapp). The sidecar is the same `lit` package
that ships in the platform wheel — the desktop just freezes it.

## Dev workflow

```bash
./start.sh          # clears stale processes, verifies port 1420 is free, launches
```

`start.sh` exists because of the **single most common dev-loop trap here**:
`tauri dev` loads the frontend from the Vite dev server on `:1420`. If a previous
run left a dead Vite or a stale app window behind, the new run silently attaches
to nothing and you stare at a **cached page** — edits appear to do nothing. The
script kills the old app binary + any stray Vite, aborts loudly if `:1420` is
still held, then launches.

**Diagnosing "my change isn't showing up":**
- `ss -ltn | grep 1420` — is anything even serving the frontend?
- `curl -s http://localhost:1420/src/styles.css | grep <your-edit>` — is Vite
  serving your edit? If yes and the window looks stale, the webview cached it →
  fully quit and relaunch (there is no hard-reload in the Tauri webview).
- Check the running app binary's start time (`ps -eo pid,lstart,args | grep
  target/debug/lit-server`). If it predates your edit, your "restart" didn't take.

Ports: Vite `1420`, HMR websocket `1421` (see `vite.config.ts`).

## The frozen sidecar (backend/)

The Python backend is frozen into a single executable via PyInstaller
(`backend/lit-server.spec`, entry point `backend/lit-server-entry.py`).

> **`tauri dev` does NOT re-freeze the sidecar.** It reuses the pre-built binary
> at `src-tauri/binaries/lit-server-<triple>`. So **changes to `lit-server-entry.py`
> or the `lit` package have zero effect until you re-freeze.** This bites you when
> a fix is committed to source but the running app still shows the old behavior —
> always check the binary's build date against the commit date.

### Re-freezing

Requires a venv with `pyinstaller` + the `lit` wheel installed
(`/opt/lit-platform/.venv` on the dev box):

```bash
cd backend
# LIT_BRIDGE_RS_BUNDLE bundles the native Rust bridge INSIDE the sidecar so a
# distributed app doesn't fall back to a dev-tree path that only exists here.
LIT_BRIDGE_RS_BUNDLE=/opt/lit-platform/lit-bridge-rs/target/release/lit-bridge-rs \
  /opt/lit-platform/.venv/bin/pyinstaller --noconfirm lit-server.spec
# onefile output → backend/dist/lit-server ; install it as the sidecar:
cp dist/lit-server ../src-tauri/binaries/lit-server-x86_64-unknown-linux-gnu
chmod +x ../src-tauri/binaries/lit-server-x86_64-unknown-linux-gnu
```

`src-tauri/binaries/` is gitignored — the frozen binary is a build artifact, not
source. `scripts/build-brand.sh` copies `lit-server-<triple>` to a brand-specific
sidecar name (e.g. `jovai-server-<triple>`) for white-label builds.

Notes on the spec:
- **onefile** (`upx=True`) — you can't reliably `grep` the binary to check what's
  in it (UPX-compressed; bytecode strips comments). Verify by source + build date.
- The spec collects `lit` from **site-packages** (installed wheel), not local src —
  this repo carries no lit-lib source.

## Bridge socket isolation (desktop + webapp coexistence)

The `claude-interactive` backend spawns the native bridge (`lit-bridge-rs`) on a
Unix socket at `{XDG_RUNTIME_DIR}/lit-bridge-rs-<user>.sock`. A login session sets
`XDG_RUNTIME_DIR=/run/user/<uid>` — shared across every process the user runs. So
the desktop app and a dev webapp running as the same user would put their sockets
at the **same path** and hijack each other's bridge sessions (terminal dies,
"reconnecting…", the classic `rm /run/user/1000/lit-bridge-rs-ben.sock` dance).

**Fix** (`lit-server-entry.py`): when frozen, force `XDG_RUNTIME_DIR` to an
app-private dir (`~/.local/share/lit-desktop/run/`). The desktop then gets its
own bridge socket, guaranteed unique, and coexists with the webapp (which keeps
`/run/user/<uid>`). This is unconditional in the frozen entry point — but it only
takes effect **after a re-freeze** (see above), which is exactly the trap that
made this look unfixed for a while.

## `setdefault` vs the ambient environment (a recurring trap)

`lit-server-entry.py` sets a batch of env vars for the sandbox. Anything that
**must** hold for the desktop has to be a hard assignment, not `setdefault` —
because a dev/server box's login session or `/etc/environment` may already export
that variable, making `setdefault` a silent no-op. Two bugs came from exactly this:

- **`XDG_RUNTIME_DIR`** — the login session always sets it → bridge-socket
  collision (above).
- **`LIT_LOCAL_MODE`** — this box's `/etc/environment` sets it to `false` for the
  multi-user server. Inherited, the desktop backend came up in multi-user mode, so
  the channel WebSocket (`/mux/ws/channel/{id}`) demanded an auth token the desktop
  never sends and **403-ed every connection** — the UI showed "Reconnecting…"
  forever (HTTP still worked, which masked it). Forced to `true` now (the desktop
  is always single-user).

Rule of thumb: if the desktop's correctness depends on a value, **force it**; use
`setdefault` only for genuinely overridable defaults. And remember any such change
needs a **re-freeze** to reach the running app.

## dockview theming (the panel-stays-dark gotcha)

The docking layer is [`dockview-core`](https://dockview.dev) (framework-agnostic).
Panels are mounted by `panel-host.ts` (`VanillaPanelRenderer`); `window-manager.ts`
wraps the dockview API (layout persistence, single-tab header hiding, theme).

dockview themes are CSS-variable classes (`dockview-theme-light` / `-abyss`).
**The trap:** dockview applies its theme class — and thus declares vars like
`--dv-group-view-background-color` — **on its own root element (`.dv-dockview`)**,
not on a shared ancestor. So setting the theme class on `<body>` or overriding the
var on `#dockview-container` (an *ancestor*) **loses**: the element that reads the
var also declares it, and a self-declaration beats an inherited one. The panel
stayed dark in light mode no matter what we set upstream.

**Fix** (`styles.css`): force the background **directly on the group surfaces**
with `#id .class` specificity (0,1,1), which outranks dockview's bare-class rule
(0,0,1), and drive it from the app's own theme vars (keyed to `data-theme` on
`<html>`):

```css
#dockview-container .dv-dockview,
#dockview-container .dv-groupview {
  background-color: var(--bg-primary);   /* flips with data-theme */
}
```

`window-manager.ts#setTheme` still toggles the `dockview-theme-*` class on
`<body>` — needed for dockview's floating drag/drop overlays, which portal out to
`document.body` and would otherwise be unthemed.

## Layout

| Path | What |
|------|------|
| `src/main.ts` | App bootstrap, sidebar, dock setup, commands, keybindings |
| `src/window-manager.ts` | dockview wrapper (init, addPanel, theme, persist/restore) |
| `src/panel-host.ts` | Panel registry + `VanillaPanelRenderer` |
| `src/api.ts` | HTTP calls to the sidecar |
| `src/styles.css` | App theme vars (`data-theme`) + dockview overrides |
| `backend/lit-server-entry.py` | PyInstaller entry: env sandboxing, bridge bundling |
| `backend/lit-server.spec` | Freeze recipe |
| `src-tauri/` | Tauri Rust shell + config (gitignored `binaries/`) |
| `start.sh` | Clean dev launcher |
| `scripts/build-brand.sh` | White-label rebrand of the sidecar + Tauri config |
