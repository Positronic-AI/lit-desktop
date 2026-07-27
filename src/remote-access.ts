/**
 * Presence v1 — the attach pipe (desktop side).
 *
 * For every server connection with `remoteAccess` enabled, this module holds
 * an OUTBOUND WebSocket to that server's `/mux/ws/remote/attach`, announcing
 * this desktop so the server's web portal can show it under "Your devices".
 *
 * Invariants (docs/plans/desktop-remote-access.md):
 * - The desktop dials out; the server never connects in.
 * - Authenticated with the same Keycloak bearer the connection already holds.
 * - Live-only: closing the pipe (toggle off, app quit) makes this device
 *   vanish from the server instantly — nothing is stored at rest there.
 * - Slice 1 speaks only hello/ping/pong; the RPC surface comes in later
 *   slices and will be an enumerated allow-list.
 */

import {
  getConnections,
  saveConnection,
  ensureFreshToken,
  fetchTeams,
  fetchChannels,
  fetchChannelMessages,
  postChannelMessage,
  fetchFullAgents,
  setChannelAgent,
  createRemoteAttachWebSocket,
  createChannelWebSocket,
  type Connection,
  type Scope,
} from "./api";
import { brand } from "./brand";

const DEVICE_ID_KEY = "lit-remote-device-id";
const DEVICE_NAME_KEY = "lit-remote-device-name";

/** Stable per-install device id, so the portal can pin this device across
 *  reattaches without its identity changing. */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `dev-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getDeviceName(): string {
  return localStorage.getItem(DEVICE_NAME_KEY) || `${brand.displayName} desktop`;
}

export function setDeviceName(name: string): void {
  localStorage.setItem(DEVICE_NAME_KEY, name.trim().slice(0, 64));
  // Re-announce under the new name on every live pipe.
  for (const pipe of pipes.values()) pipe.restart();
}

class AttachPipe {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private backoffMs = 5000;
  private stopped = false;

  constructor(private connId: string) {}

  private conn(): Connection | undefined {
    return getConnections().find((c) => c.id === this.connId);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  restart(): void {
    this.stop();
    void this.start();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 60000);
  }

  private async connect(): Promise<void> {
    const conn = this.conn();
    if (!conn || !conn.remoteAccess || this.stopped) return;
    try {
      await ensureFreshToken(conn);
    } catch (e) {
      console.warn(`[remote-access] token refresh failed for ${conn.name}:`, e);
      this.scheduleReconnect();
      return;
    }
    if (!this.conn()?.token) {
      // ensureFreshToken clears tokens on a dead refresh (400/401) — the user
      // is signed out; stop dialing rather than looping, and say so.
      console.warn(`[remote-access] ${conn.name}: signed out (refresh rejected) — pipe idle until re-sign-in`);
      this.scheduleReconnect();
      return;
    }
    let teams: string[] = ["local"];
    try {
      const local = getConnections().find((c) => c.id === "local");
      if (local) {
        const localTeams = await fetchTeams({ connection: local, team: "local" });
        if (localTeams?.length) teams = localTeams.map((t: any) => t.id || t.name).slice(0, 32);
      }
    } catch { /* default stands */ }

    try {
      const ws = createRemoteAttachWebSocket(conn);
      this.ws = ws;
      ws.onopen = () => {
        this.backoffMs = 5000;
        ws.send(JSON.stringify({
          type: "hello",
          device_id: getDeviceId(),
          name: getDeviceName(),
          teams,
        }));
        this.pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 25000);
      };
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data);
          if (frame.type === "attached") {
            console.log(`[remote-access] attached to ${conn.name} as ${frame.device_id}`);
          } else if (frame.type === "rpc" && frame.id) {
            void handleRpcFrame(ws, frame);
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        this.ws = null;
        closeStreamBridgesForPipe(ws);
        console.warn(`[remote-access] pipe to ${conn.name} closed — retrying in ${this.backoffMs / 1000}s`);
        this.scheduleReconnect();
      };
      ws.onerror = (e) => { console.warn(`[remote-access] pipe error (${conn.name}):`, e); };
    } catch (e) {
      console.warn(`[remote-access] could not open pipe to ${conn.name}:`, e);
      this.scheduleReconnect();
    }
  }
}

/** RPC adapter — the server proxies portal requests over the pipe as
 *  `{type:"rpc", id, op, params}` frames. Each op is a thin call against the
 *  LOCAL backend; the op set is an allow-list on BOTH ends (the desktop does
 *  not trust the server blindly either). Anything unknown returns an error. */
function localScope(team: string): Scope {
  const local = getConnections().find((c) => c.id === "local");
  if (!local) throw new Error("no local connection");
  return { connection: local, team };
}

async function handleRpcFrame(ws: WebSocket, frame: { id: string; op?: string; params?: any }): Promise<void> {
  const reply = (body: object) =>
    ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "result", id: frame.id, ...body }));
  try {
    const params = frame.params || {};
    let result: unknown;
    switch (frame.op) {
      case "teams.list":
        result = await fetchTeams(localScope("local"));
        break;
      case "channels.list":
        result = await fetchChannels(localScope(String(params.team || "local")));
        break;
      case "messages.page":
        result = await fetchChannelMessages(
          String(params.channel || ""),
          Math.min(Number(params.limit) || 50, 100),
          localScope(String(params.team || "local")),
        );
        break;
      case "messages.send": {
        const content = String(params.content || "").trim();
        if (!content) throw new Error("empty message");
        await postChannelMessage(
          String(params.channel || ""),
          content,
          localScope(String(params.team || "local")),
        );
        result = { sent: true };
        break;
      }
      case "agents.list": {
        // Portal agent tabs. Ship only what the strip needs — never the
        // system prompt or other config over the pipe.
        const team = String(params.team || "local");
        const agents = await fetchFullAgents(team, localScope(team));
        result = agents.map((a) => ({ id: a.id, name: a.name, backend: a.backend, model: a.model }));
        break;
      }
      case "channel.set_agent": {
        await setChannelAgent(
          String(params.channel || ""),
          String(params.agent_id || ""),
          localScope(String(params.team || "local")),
        );
        result = { set: true };
        break;
      }
      case "stream.subscribe": {
        const sub = String(params.sub || "");
        if (!sub) throw new Error("missing sub id");
        openStreamBridge(ws, sub, String(params.channel || ""), String(params.team || "local"));
        result = { subscribed: true };
        break;
      }
      case "stream.unsubscribe": {
        closeStreamBridge(String(params.sub || ""));
        result = { unsubscribed: true };
        break;
      }
      default:
        throw new Error(`unknown op: ${frame.op}`);
    }
    reply({ result });
  } catch (e) {
    reply({ error: String((e as any)?.message ?? e) });
  }
}

/** Live stream bridges: the server subscribed a portal session to one of our
 *  channels; we open our own LOCAL channel WS and forward every event up the
 *  pipe as `{type:"ev", sub, data}` frames. Closed on unsubscribe, pipe
 *  death, or local WS close. */
const streamBridges = new Map<string, { local: WebSocket; pipe: WebSocket }>();

function openStreamBridge(pipe: WebSocket, sub: string, channelId: string, team: string): void {
  closeStreamBridge(sub);
  const local = createChannelWebSocket(channelId, localScope(team));
  local.onmessage = (ev) => {
    if (pipe.readyState !== WebSocket.OPEN) { closeStreamBridge(sub); return; }
    try {
      pipe.send(JSON.stringify({ type: "ev", sub, data: JSON.parse(ev.data) }));
    } catch { /* unparseable local frame — skip */ }
  };
  local.onclose = () => {
    // Local backend closed the WS (restart etc.) — tell the portal.
    if (pipe.readyState === WebSocket.OPEN) {
      pipe.send(JSON.stringify({ type: "ev", sub, data: { type: "stream_bridge_closed" } }));
    }
    streamBridges.delete(sub);
  };
  streamBridges.set(sub, { local, pipe });
  console.log(`[remote-access] stream bridge open: sub=${sub} channel=${channelId}`);
}

function closeStreamBridge(sub: string): void {
  const bridge = streamBridges.get(sub);
  if (!bridge) return;
  streamBridges.delete(sub);
  bridge.local.onclose = null;
  bridge.local.close();
  console.log(`[remote-access] stream bridge closed: sub=${sub}`);
}

function closeStreamBridgesForPipe(pipe: WebSocket): void {
  for (const [sub, bridge] of streamBridges) {
    if (bridge.pipe === pipe) closeStreamBridge(sub);
  }
}

const pipes = new Map<string, AttachPipe>();

/** Reconcile pipes with connection state — call at boot and after any
 *  connection change (toggle, sign-in/out, removal). */
export function syncRemoteAccessPipes(): void {
  for (const conn of getConnections()) {
    const want = !!(conn.remoteAccess && conn.auth === "keycloak" && conn.refreshToken);
    const have = pipes.get(conn.id);
    if (want && !have) {
      const pipe = new AttachPipe(conn.id);
      pipes.set(conn.id, pipe);
      void pipe.start();
    } else if (!want && have) {
      have.stop();
      pipes.delete(conn.id);
    }
  }
  // Pipes for removed connections
  for (const [id, pipe] of pipes) {
    if (!getConnections().some((c) => c.id === id)) {
      pipe.stop();
      pipes.delete(id);
    }
  }
}

/** Toggle remote access for a connection and reconcile immediately. */
export function setRemoteAccess(connId: string, enabled: boolean): void {
  const conn = getConnections().find((c) => c.id === connId);
  if (!conn) return;
  saveConnection({ ...conn, remoteAccess: enabled });
  syncRemoteAccessPipes();
}
