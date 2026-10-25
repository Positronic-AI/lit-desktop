// "Link this computer" — host affinity from the desktop app.
//
// The server's Settings → Computers tells people to install this app and flip
// one switch. The switch does exactly what the command line does: it asks the
// server for a device token (the phone's credential, reused), then runs the
// sidecar as `lit link <server> <token> --name <device>` which mints a key,
// opens the reverse tunnel, mounts the home's memory and the affinity
// channels' stores, and leaves all of it running as user services. Off runs
// `lit unlink --remote`. Nothing here is required to keep running afterwards.
import { Command as ShellCommand } from "@tauri-apps/plugin-shell";
import { Connection, authHeaders, ensureFreshToken, setConnectionLinked } from "./api";
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
  const r = await fetch(`${homeUrl(conn)}/mux/device-link`, {
    method: "POST", headers: { ...authHeaders(conn), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "computer" }),
  });
  if (!r.ok) throw new Error(`The server would not issue a link token (${r.status}). Sign in again and retry.`);
  const { token } = await r.json();
  const name = (getDeviceName() || "computer").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "computer";
  await runLit(["link", homeUrl(conn), token, "--name", name, "--location", "desktop app"]);
  setConnectionLinked(conn.id, { name, home: conn.name, at: new Date().toISOString() });
}

export async function unlinkThisComputer(conn: Connection): Promise<void> {
  try {
    await runLit(["unlink", homeUrl(conn), "--remote"]);  // this home only; other homes keep their links
  } finally {
    setConnectionLinked(conn.id, null);
  }
}

/** The sidecar's own view of the links (`lit link --status`): every home this computer is linked to. */
export async function linkStatus(): Promise<{ linked: boolean; homes?: { url: string; name: string; home: string; slug: string; services: string[] }[] } | null> {
  try {
    return JSON.parse(await runLit(["link", "--status"]));
  } catch {
    return null;
  }
}
