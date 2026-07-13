// Live terminal — attaches the webview to a running claude-interactive PTY
// via the server's /ws/terminal-attach bridge (no SSH). Interactive: keystrokes
// reach the real Claude TUI.
//
// The bridge renders the TUI on a FIXED grid (lit-bridge-rs: ROWS=50, COLS=200)
// with no resize channel. So we pin xterm to that exact geometry and scale the
// font to fill the panel — matching the session grid the way the web app does.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getServer } from "./api";

const BRIDGE_COLS = 200;
const BRIDGE_ROWS = 50;

let term: Terminal | null = null;
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
    cols: BRIDGE_COLS,
    rows: BRIDGE_ROWS,
    cursorBlink: true,
    theme: { background: "#1e2127", foreground: "#abb2bf" },
    scrollback: 5000,
  });
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

// Scale font so the fixed 200×50 grid fills the panel without wrapping.
export function fitToGrid(): void {
  if (!term || !hostEl) return;
  const w = hostEl.clientWidth - 12;   // padding allowance
  const h = hostEl.clientHeight - 12;
  if (w <= 0 || h <= 0) return;
  // xterm monospace: char width ≈ 0.6·fontSize, row height ≈ 1.2·fontSize.
  const fsW = w / (BRIDGE_COLS * 0.6);
  const fsH = h / (BRIDGE_ROWS * 1.2);
  const fs = Math.max(4, Math.floor(Math.min(fsW, fsH)));
  term.options.fontSize = fs;
  term.resize(BRIDGE_COLS, BRIDGE_ROWS);
}

export function closeTerminal(): void {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (term) { try { term.dispose(); } catch {} term = null; }
  hostEl = null;
  currentChannelId = null;
}
