// desktop.log — the shell's own log (~/.local/share/lit-desktop/logs/desktop.log),
// written by the Rust side so it survives webview crashes; the support bundle
// ships it beside backend.log. A webview renderer death is invisible to the
// backend log (Katie, 2026-09-23: Alms frame → sad face → relaunch looked like
// "the backend restarted with no error"), so anything the shell observes about
// panels, the backend process and the webview goes here.
import { invoke } from "@tauri-apps/api/core";

export function desktopLog(line: string): void {
  console.log(line);
  // Outside Tauri (vite in a browser) the invoke rejects — logging is best-effort.
  invoke("desktop_log", { line }).catch(() => {});
}

export async function readDesktopLog(): Promise<string> {
  try {
    return await invoke<string>("read_desktop_log");
  } catch {
    return "";
  }
}
