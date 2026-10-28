// "Link this computer" — host affinity from the desktop app.
//
// The server's Settings → Computers tells people to install this app and flip
// one switch. The switch does exactly what the command line does: it asks the
// server for a device token (the phone's credential, reused), then runs the
// sidecar as `lit hands <server> <token> --name <device>`, which installs the
// always-on hands service (systemd --user, launchd, or a Windows scheduled
// task) that dials the home over ONE outbound connection and serves turns
// here: no ssh server, no tunnel, no mounts — memory and channel stores are
// caches the home fills (docs/plans/hands-service-2026-10-26.md). Off runs
// `lit hands --uninstall <server>` and removes the host record on the home.
// Nothing in this window has to keep running afterwards; the service does.
import { Command as ShellCommand } from "@tauri-apps/plugin-shell";
import { Connection, authHeaders, ensureFreshToken, hostFetch, setConnectionLinked } from "./api";
import { brand } from "./brand";
import { getDeviceName } from "./remote-access";

async function runLit(args: string[]): Promise<string> {
  const cmd = ShellCommand.sidecar(`binaries/${brand.sidecarName}`, args);
  const out = await cmd.execute();
  if (out.code !== 0) {
    throw new Error((out.stderr || out.stdout || `lit ${args[0]} failed (${out.code})`).trim());
  }
  return out.stdout;
}

function homeUrl(conn: Connection): string {
  return conn.url.replace(/\/mux\/?$/, "").replace(/\/$/, "");
}

export async function linkThisComputer(conn: Connection): Promise<void> {
  await ensureFreshToken(conn);
  // hostFetch, not the webview's fetch: a packaged webview cannot reach a remote
  // server directly (2026-10-28, Windows 2.5.18: "Failed to fetch" on the toggle).
  const r = await hostFetch(`${homeUrl(conn)}/mux/device-link`, {
    method: "POST", headers: { ...authHeaders(conn), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "computer" }),
  });
  if (!r.ok) throw new Error(`The server would not issue a link token (${r.status}). Sign in again and retry.`);
  const { token } = await r.json();
  const name = (getDeviceName() || "computer").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "computer";
  await runLit(["hands", homeUrl(conn), token, "--name", name]);
  setConnectionLinked(conn.id, { name, home: conn.name, at: new Date().toISOString() });
}

export async function unlinkThisComputer(conn: Connection): Promise<void> {
  const name = conn.linked?.name;
  try {
    await runLit(["hands", "--uninstall", homeUrl(conn)]);  // this home only; other homes keep their service
    // The host record on the home outlives the service (Settings → Computers would
    // still list this computer, offline). Drop it too; best effort.
    if (name) {
      try {
        await ensureFreshToken(conn);
        await hostFetch(`${homeUrl(conn)}/mux/hosts/${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders(conn) });
      } catch { /* the service is gone either way */ }
    }
  } finally {
    setConnectionLinked(conn.id, null);
  }
}

/** The sidecar's own view (`lit hands --status`): every home this computer serves, and whether the service runs. */
export async function linkStatus(): Promise<{ platform: string; homes: { url: string; name: string; linked_at: string; slug: string; service: string; running: boolean }[] } | null> {
  try {
    return JSON.parse(await runLit(["hands", "--status"]));
  } catch {
    return null;
  }
}
