// Live terminal — attaches the webview to a running claude-interactive PTY
// via the server's /ws/terminal-attach bridge (no SSH). Interactive: keystrokes
// reach the real Claude TUI.
//
// The bridge paints a FIXED 200×50 grid (lit-bridge-rs) with no resize. The web
// app handles this by sizing its xterm to FILL the panel (a grid ≥ 200×50) and
// letting the fixed content sit in the top-left — the extra cells are blank
// terminal background, invisible. We do the same: fit xterm to the panel at a
// font small enough that cols ≥ 200 and rows ≥ 50 (so the 200-col content never
// wraps/garbles). No pinning, no scaling, no letterbox gutters.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getServer } from "./api";

const BRIDGE_COLS = 200;
const BRIDGE_ROWS = 50;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let hostEl: HTMLElement | null = null;
let currentChannelId: string | null = null;

export function isTerminalOpen(): boolean {
  return term !== null;
}

export function terminalChannel(): string | null {
  return currentChannelId;
}

export function openTerminal(container: HTMLElement, channelId: string): void {
  closeTerminal();
  currentChannelId = channelId;
  hostEl = container;

  term = new Terminal({
    fontFamily: '"Cascadia Code", Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    theme: { background: "#1e2127", foreground: "#abb2bf" },
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fitToGrid();

  const base = getServer().url.replace(/^http/, "ws");
  const url = `${base}/mux/ws/terminal-attach?channel_id=${encodeURIComponent(channelId)}`;
  term.write(`\x1b[90mAttaching to live session for #${channelId}…\x1b[0m\r\n`);

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") term?.write(ev.data);
    else term?.write(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onclose = (ev) => {
    const why = ev.reason ? `: ${ev.reason}` : "";
    term?.write(`\r\n\x1b[90m[terminal disconnected${why}]\x1b[0m\r\n`);
  };
  ws.onerror = () => {
    term?.write(`\r\n\x1b[31m[terminal connection error]\x1b[0m\r\n`);
  };
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// Fill the panel with no wrapping and no gutter. We do NOT guess cell metrics
// (that caused the wrap-on-resize + bottom gutter). Instead we try fonts from
// large to small, fit, and MEASURE xterm's actual cols/rows — stopping at the
// largest font where the grid is still ≥ 200×50. That guarantees the 200-col
// content never wraps (cols ≥ 200) and the panel height is used (rows ≥ 50),
// while keeping the text as large as possible.
export function fitToGrid(): void {
  if (!term || !fit || !hostEl) return;
  if (!hostEl.clientWidth || !hostEl.clientHeight) return;
  for (let fs = 16; fs >= 5; fs--) {
    term.options.fontSize = fs;
    try { fit.fit(); } catch { return; }
    if (term.cols >= BRIDGE_COLS && term.rows >= BRIDGE_ROWS) return;
  }
  // Panel too small for a full 200×50 even at 5px — leave the last fit.
}

export function closeTerminal(): void {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (term) { try { term.dispose(); } catch {} term = null; }
  fit = null;
  hostEl = null;
  currentChannelId = null;
}
