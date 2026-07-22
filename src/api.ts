export interface ServerConfig {
  url: string;
  name: string;
}

export interface Agent {
  id: string;
  name: string;
  backend: string;
  model: string;
  status: string;
  heartbeat_enabled?: boolean;
  effort?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  unreadCount: number;
  lastMessage?: {
    id: string;
    timestamp: string;
    from: string;
  };
}

export interface ChannelMessage {
  id: string;
  file: string;
  timestamp: string;
  direction: "in" | "out";
  from: string;
  content: string;
  role: "user" | "assistant" | "system";
  read: boolean;
  metadata?: Record<string, unknown>;
  file_path?: string;
}

export interface UsageQuota {
  name: string;
  used: number; // 0.0 - 1.0
  resets_at?: string | null;
}

export interface UsageReport {
  provider: string;
  available: boolean;
  error?: string | null;
  quotas: UsageQuota[];
  fetched_at: string;
}

export interface BackendModel {
  name: string;
  display_name: string;
}

export type ThrottleState = "disabled" | "enabled" | "safe" | "stopped";

// ---- Connections (servers) ----
// A Connection makes a host's addresses reachable (see docs/plans/address-model.md).
// "Connection" always means a server connection — frontier-model credentials are
// "credentials", a different noun. The list is personal chrome: stored locally,
// never on any server. The Local connection is always present and needs no auth.

export interface Connection {
  id: string;
  name: string;      // "Local", "JovAI (jupiter)"
  url: string;       // http://127.0.0.1:5000, https://app.jov.ai
  auth: "none" | "keycloak";
  authUrl?: string;  // https://auth.lit.ai (until servers expose auth discovery)
  realm?: string;    // JOV-AI
  // Tokens from the device-flow sign-in. Access tokens live ~5 minutes on our
  // realms — apiFetch refreshes proactively; the refresh token rides the
  // Keycloak SSO session (days), so one sign-in lasts as long as the session.
  token?: string;
  refreshToken?: string;
  tokenExpiresAt?: number; // unix seconds
}

const LOCAL_CONNECTION: Connection = {
  id: "local",
  name: "Local",
  // 127.0.0.1, not "localhost": on Windows localhost can resolve to IPv6 ::1
  // first, but the backend binds IPv4 127.0.0.1 only — so localhost fails to
  // connect there. 127.0.0.1 hits the exact bind address on every platform.
  url: "http://127.0.0.1:5000",
  auth: "none",
};

const CONNECTIONS_KEY = "lit-connections";
const ACTIVE_CONNECTION_KEY = "lit-active-connection";

function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as Connection[];
      if (Array.isArray(list)) {
        // Local is pinned first and can't be removed or drift.
        return [LOCAL_CONNECTION, ...list.filter((c) => c && c.id !== "local")];
      }
    }
  } catch { /* corrupted store — fall back to just Local */ }
  return [LOCAL_CONNECTION];
}

let connections: Connection[] = loadConnections();
let activeConnectionId = localStorage.getItem(ACTIVE_CONNECTION_KEY) || "local";

function persistConnections(): void {
  localStorage.setItem(
    CONNECTIONS_KEY,
    JSON.stringify(connections.filter((c) => c.id !== "local")),
  );
}

export function getConnections(): Connection[] {
  return connections;
}

export function getActiveConnection(): Connection {
  return connections.find((c) => c.id === activeConnectionId) ?? LOCAL_CONNECTION;
}

/** Add or update a connection (by id) and persist. */
export function saveConnection(conn: Connection): void {
  const i = connections.findIndex((c) => c.id === conn.id);
  if (i >= 0) connections[i] = conn;
  else connections.push(conn);
  persistConnections();
}

/** Remove a connection. Local can't be removed; removing the active one flips to Local. */
export function removeConnection(id: string): void {
  if (id === "local") return;
  connections = connections.filter((c) => c.id !== id);
  persistConnections();
  if (activeConnectionId === id) setActiveConnectionId("local");
}

export function setActiveConnectionId(id: string): void {
  activeConnectionId = connections.some((c) => c.id === id) ? id : "local";
  localStorage.setItem(ACTIVE_CONNECTION_KEY, activeConnectionId);
}

// ---- Sign-in (Keycloak device flow) ----
// The desktop is a public OAuth client using the Device Authorization Grant:
// no client secret, no redirect URI, no loopback server — the browser does the
// login, the app polls for tokens. Client `lit-desktop` is registered per realm.

const DEVICE_CLIENT_ID = "lit-desktop";

export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function oidcBase(conn: Connection): string {
  return `${(conn.authUrl || "").replace(/\/+$/, "")}/realms/${conn.realm}/protocol/openid-connect`;
}

export async function startDeviceAuth(conn: Connection): Promise<DeviceAuthStart> {
  const res = await fetch(`${oidcBase(conn)}/auth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID, scope: "openid" }),
  });
  if (!res.ok) throw new Error(`Device auth failed: ${res.status}`);
  return res.json();
}

/** One poll for the device-flow token. Returns true once signed in (tokens are
 *  stored on the connection), false while the user hasn't approved yet. */
export async function pollDeviceToken(conn: Connection, deviceCode: string): Promise<boolean> {
  const res = await fetch(`${oidcBase(conn)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: DEVICE_CLIENT_ID,
    }),
  });
  const data = await res.json();
  if (res.ok) {
    storeTokens(conn, data);
    return true;
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") return false;
  throw new Error(data.error_description || data.error || `token poll failed: ${res.status}`);
}

function storeTokens(conn: Connection, data: { access_token: string; refresh_token?: string; expires_in: number }): void {
  conn.token = data.access_token;
  if (data.refresh_token) conn.refreshToken = data.refresh_token;
  conn.tokenExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 300);
  saveConnection(conn);
}

/** Who the connection is signed in as, from the access token's claims. */
export function signedInUser(conn: Connection): string | null {
  if (!conn.token) return null;
  try {
    const payload = JSON.parse(atob(conn.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.preferred_username || payload.email || null;
  } catch {
    return null;
  }
}

/** Refresh the access token if it's missing or expiring within 30s. A dead
 *  refresh token (SSO session ended) clears auth so the UI shows Sign in again. */
async function ensureFreshToken(conn: Connection): Promise<void> {
  if (conn.auth !== "keycloak" || !conn.refreshToken) return;
  const now = Math.floor(Date.now() / 1000);
  if (conn.token && conn.tokenExpiresAt && conn.tokenExpiresAt - now > 30) return;
  const res = await fetch(`${oidcBase(conn)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
      client_id: DEVICE_CLIENT_ID,
    }),
  });
  if (res.ok) {
    storeTokens(conn, await res.json());
  } else if (res.status === 400 || res.status === 401) {
    conn.token = undefined;
    conn.refreshToken = undefined;
    conn.tokenExpiresAt = undefined;
    saveConnection(conn);
  }
}

/** Auth headers for the active connection — for the few call sites that fetch()
 *  directly (DELETE/cancel endpoints, iframe-adjacent requests) instead of apiFetch. */
export function authHeaders(): Record<string, string> {
  const conn = getActiveConnection();
  return conn.token ? { Authorization: `Bearer ${conn.token}` } : {};
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const conn = getActiveConnection();
  await ensureFreshToken(conn);
  const headers = new Headers(options?.headers);
  if (conn.token) headers.set("Authorization", `Bearer ${conn.token}`);
  const res = await fetch(`${conn.url}/mux${path}`, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`AUTH_REQUIRED: ${res.status} from ${conn.name}`);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export function getServer(): ServerConfig {
  const conn = getActiveConnection();
  return { url: conn.url, name: conn.name };
}

/** @deprecated Use saveConnection + setActiveConnectionId. Kept for compatibility. */
export function setServer(config: ServerConfig) {
  saveConnection({ id: config.name, name: config.name, url: config.url, auth: "none" });
  setActiveConnectionId(config.name);
}

// ---- Teams (workspace separation) ----
// The active team scopes every data call (channels/agents/credentials/search/KG).
// Backend auto-creates the default "local" team; data lives under ~/.lit/data/{team}/.

export interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  members: string[];
  agent_ids?: string[];
}

const TEAM_KEY = "lit-active-team";
let activeTeam = localStorage.getItem(TEAM_KEY) || "local";

export function getActiveTeam(): string {
  return activeTeam;
}

export function setActiveTeam(slug: string) {
  activeTeam = slug;
  localStorage.setItem(TEAM_KEY, slug);
}

export async function fetchTeams(): Promise<TeamInfo[]> {
  return apiFetch<TeamInfo[]>("/organizations");
}

export async function createTeam(name: string, slug: string, description = ""): Promise<TeamInfo> {
  return apiFetch<TeamInfo>("/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, slug, description }),
  });
}

export async function updateTeam(orgId: string, data: { name?: string; description?: string }): Promise<TeamInfo> {
  return apiFetch<TeamInfo>(`/organizations/${orgId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteTeam(orgId: string): Promise<void> {
  await apiFetch(`/organizations/${orgId}`, { method: "DELETE" });
}

export async function checkConnection(): Promise<boolean> {
  try {
    await apiFetch("/agents");
    return true;
  } catch {
    return false;
  }
}

/** Read a file's text from the backend (the mux commander file API). */
export async function readServerFile(path: string): Promise<string> {
  const r = await apiFetch<{ success: boolean; data?: string; error?: string }>(
    "/commander/read_file",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!r.success) throw new Error(r.error || "Failed to read file");
  return r.data ?? "";
}

export async function fetchAgents(): Promise<Agent[]> {
  const data = await apiFetch<{ agents: Agent[] }>(`/agents?team=${activeTeam}`);
  return data.agents;
}

export interface AppWidget {
  id: string;
  title: string;
  type: string; // "iframe" | "markdown" | "component"
  url?: string | null;
}

/** Team apps (published apps, e.g. an iframe widget like the fluid simulation) —
 *  the same catalog the webapp's team-apps feature draws from. */
export async function fetchApps(): Promise<AppWidget[]> {
  const data = await apiFetch<{ data: AppWidget[] }>(`/widgets?team=${activeTeam}`);
  return data.data || [];
}

export async function fetchChannels(): Promise<Channel[]> {
  const [nav, unread] = await Promise.all([
    apiFetch<{ personal_channels: Array<{ id: string; name: string; folder_path?: string }> }>(`/navigation?team=${activeTeam}`),
    apiFetch<{ channels: Array<{ id: string; unreadCount: number }> }>("/channels/unread").catch(() => ({ channels: [] })),
  ]);

  const unreadMap = new Map(unread.channels.map(c => [c.id, c.unreadCount]));
  return (nav.personal_channels || []).map(ch => ({
    id: ch.id,
    name: ch.name,
    unreadCount: unreadMap.get(ch.id) || 0,
  }));
}

export async function createChannel(name: string): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, team: activeTeam }),
  });
}

export async function fetchChannelMessages(
  channelId: string,
  limit = 50,
): Promise<ChannelMessage[]> {
  const data = await apiFetch<{ messages: ChannelMessage[] }>(
    `/channels/${channelId}/messages?limit=${limit}&team=${activeTeam}`
  );
  return data.messages || [];
}

/** Load a window of messages centered on a specific message (seekable timeline).
 *  Used to jump to a search hit that isn't in the loaded tail. */
export async function fetchMessagesAround(
  channelId: string,
  messageId: string,
  limit = 50,
): Promise<{ messages: ChannelMessage[]; hasNewer: boolean }> {
  const data = await apiFetch<{ messages: ChannelMessage[]; has_newer?: boolean }>(
    `/channels/${channelId}/messages?around=${encodeURIComponent(messageId)}&limit=${limit}&team=${activeTeam}`,
  );
  return { messages: data.messages || [], hasNewer: !!data.has_newer };
}

/** Message-count per day for the calendar heatmap: { "2026-06-01": 5, … } */
export async function fetchCalendarDates(channelId: string): Promise<Record<string, number>> {
  const data = await apiFetch<{ dates: Record<string, number> }>(
    `/channels/${channelId}/messages/calendar?team=${activeTeam}`,
  );
  return data.dates || {};
}

export interface CalendarDayMessage {
  id: string;
  timestamp: string;
  from: string;
  direction: string;
  filename: string;
}

/** All messages for a specific day (YYYY-MM-DD), lightweight (no content). */
export async function fetchCalendarDay(channelId: string, date: string): Promise<CalendarDayMessage[]> {
  const data = await apiFetch<{ messages: CalendarDayMessage[] }>(
    `/channels/${channelId}/messages/calendar?date=${encodeURIComponent(date)}&team=${activeTeam}`,
  );
  return data.messages || [];
}

/** Full raw content of a single message file, by ref ("channel/date/file.md"). */
export async function fetchMessageContent(ref: string): Promise<string | null> {
  const data = await apiFetch<{ content: string | null }>(
    `/knowledge-graph/message?ref=${encodeURIComponent(ref)}&team=${activeTeam}`,
  );
  return data.content ?? null;
}

export interface GraphNode {
  id: string;
  type: string;
  label?: string;
  count: number;
  messages: { ref: string; excerpt: string; message_id?: string }[];
}
export interface GraphEdge { source: string; target: string; weight: number; }

/** Knowledge-graph nodes+edges built from the channel's LINKS: footers. */
export async function fetchKnowledgeGraph(channelId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const data = await apiFetch<{ nodes?: GraphNode[]; edges?: GraphEdge[] }>(
    `/knowledge-graph?channel=${encodeURIComponent(channelId)}&team=${activeTeam}`,
  );
  return { nodes: data.nodes || [], edges: data.edges || [] };
}

export async function postChannelMessage(
  channelId: string,
  content: string
): Promise<void> {
  await apiFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, team: activeTeam }),
  });
}

export async function openFolder(folderPath: string, name?: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${getActiveConnection().url}/mux/channels/open-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ folder_path: folderPath, name, team: activeTeam }),
  });

  if (res.status === 409) {
    const folderName = folderPath.replace(/\/$/, "").split("/").pop() || folderPath;
    return { id: folderName, name: name || folderName };
  }

  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export async function markChannelRead(channelId: string): Promise<void> {
  await apiFetch(`/channels/${channelId}/mark-read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ team: activeTeam }),
  });
}

export async function setChannelAgent(channelId: string, agentId: string): Promise<void> {
  await fetch(`${getActiveConnection().url}/mux/channels/${channelId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ agent_id: agentId, team: activeTeam }),
  });
}

export async function getChannelConfig(channelId: string): Promise<Record<string, unknown>> {
  return apiFetch<Record<string, unknown>>(`/channels/${channelId}/config?team=${activeTeam}`);
}

/** This channel's per-agent model override, or null if it follows the agent default. */
export async function getChannelModelOverride(channelId: string, agentId: string): Promise<string | null> {
  try {
    const data = await apiFetch<{ model: string | null }>(
      `/channels/${channelId}/model-override?agent_id=${encodeURIComponent(agentId)}&team=${activeTeam}`,
    );
    return data?.model ?? null;
  } catch {
    return null;
  }
}

/** Set (empty string clears → revert to agent default) this channel's model for one agent. */
export async function setChannelModelOverride(channelId: string, agentId: string, model: string): Promise<void> {
  await apiFetch(`/channels/${channelId}/model-override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, model, team: activeTeam }),
  });
}

export interface ChannelSearchResult {
  ref: string; // "channelname/YYYY-MM-DD/NNN_dir_x.md"
  excerpt: string;
  message_id?: string;
}

/** Full-text (or regex) search over a channel's message history. */
export async function searchChannelMessages(
  channelId: string,
  q: string,
  regex = false,
): Promise<ChannelSearchResult[]> {
  const data = await apiFetch<{ results: ChannelSearchResult[] }>(
    `/channels/${channelId}/messages/search?q=${encodeURIComponent(q)}&regex=${regex}&team=${activeTeam}`,
  );
  return data.results || [];
}

export function createChannelWebSocket(channelId: string): WebSocket {
  const conn = getActiveConnection();
  const wsUrl = conn.url.replace(/^http/, "ws");
  // Token as query param — the same mechanism the webapp client uses against
  // these endpoints (WS has no headers). Team scoping rides along for remote
  // hosts, matching the webapp's channel WS URL shape.
  const params = new URLSearchParams();
  if (conn.token) params.set("token", conn.token);
  params.set("team", activeTeam);
  return new WebSocket(`${wsUrl}/mux/ws/channel/${channelId}?${params.toString()}`);
}

// --- Agent control APIs ---

export async function fetchModels(): Promise<Record<string, BackendModel[]>> {
  const data = await apiFetch<{ models: Record<string, { name: string; display_name?: string }[]> }>("/models");
  const result: Record<string, BackendModel[]> = {};
  for (const [backend, models] of Object.entries(data.models)) {
    result[backend] = models.map((m) => ({
      name: m.name || String(m),
      display_name: m.display_name || m.name || String(m),
    }));
  }
  return result;
}

export async function updateAgent(agentId: string, updates: Partial<Agent>): Promise<Agent> {
  return apiFetch<Agent>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: agentId, ...updates }),
  });
}

export async function setHeartbeatEnabled(agentId: string, enabled: boolean): Promise<{ heartbeat_enabled: boolean }> {
  return apiFetch<{ heartbeat_enabled: boolean }>(`/agents/${agentId}/heartbeat/enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function setSafeMode(agentId: string, enabled: boolean): Promise<{ safe_mode: boolean }> {
  return apiFetch<{ safe_mode: boolean }>(`/agents/${agentId}/safe_mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function getSafeMode(agentId: string): Promise<{ safe_mode: boolean }> {
  return apiFetch<{ safe_mode: boolean }>(`/agents/${agentId}/safe_mode`);
}

export async function setInterrupt(agentId: string, reason: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/heartbeat/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export async function clearInterrupt(agentId: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/heartbeat/interrupt`, {
    method: "DELETE",
  });
}

export async function getInterrupt(agentId: string): Promise<{ interrupt_requested: boolean }> {
  return apiFetch<{ interrupt_requested: boolean }>(`/agents/${agentId}/heartbeat/interrupt`);
}

export async function fetchUsage(backendId: string): Promise<UsageReport> {
  return apiFetch<UsageReport>(`/backends/${backendId}/usage`);
}

export async function cancelStream(streamId: string): Promise<void> {
  await fetch(`${getActiveConnection().url}/mux/streams/${streamId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
}

export async function uploadImage(file: File, channelId?: string): Promise<{ url: string; filename: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const base = getActiveConnection().url;
  let url = `${base}/mux/api/upload`;
  if (channelId) url += `?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url, { method: "POST", headers: authHeaders(), body: formData });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return { url: `${base}/mux${data.url}`, filename: data.filename };
}

// --- Credentials / Connections ---

export type Vendor = "anthropic" | "google" | "openai" | "local";
export type CredMode = "subscription" | "api_key" | "local";
export type CredStatus = "authed" | "expiring" | "expired" | "unconfigured";

export interface Credential {
  id: string | null;
  name: string;
  vendor: Vendor;
  mode: CredMode;
  status: CredStatus;
  is_default: boolean;
  has_manifest: boolean;
}

export interface TokenDetails {
  scopes?: string[];
  expires_in?: string;
  expires_at?: number;
  auth_method?: string;
}

export interface BackendStatus {
  id: string;
  registered?: boolean;
  enabled?: boolean;
  healthy?: boolean;
  configured?: boolean;
  auth_status: string;
  error?: string | null;
  token_details?: TokenDetails | null;
  warning?: string | null;
}

// Which backend serves a given (vendor, mode) — mirror of the server's
// _BACKEND_BY_VENDOR_MODE, used to pick the status/OAuth endpoint.
export function backendForVendorMode(vendor: Vendor, mode: CredMode): string {
  if (vendor === "anthropic") return "claude-cli";
  if (vendor === "google") return mode === "subscription" ? "antigravity" : "gemini";
  if (vendor === "openai") return "chatgpt";
  return "claude-cli";
}

export async function listCredentials(team = "local"): Promise<Credential[]> {
  const data = await apiFetch<{ credentials: Credential[] }>(`/credentials?team=${team}`);
  return data.credentials || [];
}

export async function createCredential(
  req: { id: string; name: string; vendor: Vendor; mode: CredMode },
  team = getActiveTeam(),
): Promise<Credential> {
  return apiFetch<Credential>(`/credentials?team=${team}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

export async function updateCredential(
  cid: string,
  updates: { name?: string; status?: CredStatus },
  team = getActiveTeam(),
): Promise<Credential> {
  return apiFetch<Credential>(`/credentials/${cid}?team=${team}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteCredential(cid: string, team = "local"): Promise<void> {
  await apiFetch(`/credentials/${cid}?team=${team}`, { method: "DELETE" });
}

export async function setCredentialApiKey(cid: string, apiKey: string, team = "local"): Promise<Credential> {
  return apiFetch<Credential>(`/credentials/${cid}/api-key?team=${team}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export async function fetchBackendStatus(backendId: string, credentialsId?: string): Promise<BackendStatus> {
  const q = credentialsId ? `?credentials_id=${encodeURIComponent(credentialsId)}` : "";
  return apiFetch<BackendStatus>(`/backends/${backendId}/status${q}`);
}

// --- OAuth (paste-code flow: claude-cli, gemini, antigravity) ---

export interface OAuthSession {
  session_id: string;
  status: string;
  oauth_url?: string | null;
  device_url?: string | null;
  device_code?: string | null;
  error?: string | null;
}

export async function startOAuth(backendId: string, credentialsId?: string): Promise<OAuthSession> {
  const q = credentialsId ? `?credentials_id=${encodeURIComponent(credentialsId)}` : "";
  return apiFetch<OAuthSession>(`/backends/${backendId}/auth/start${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function oauthStatus(backendId: string, sessionId: string): Promise<OAuthSession> {
  return apiFetch<OAuthSession>(`/backends/${backendId}/auth/status?session_id=${encodeURIComponent(sessionId)}`);
}

export async function submitOAuthCode(backendId: string, sessionId: string, code: string): Promise<{ status: string; error?: string | null }> {
  return apiFetch(`/backends/${backendId}/auth/submit-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, code }),
  });
}

export async function cancelOAuth(backendId: string, sessionId: string): Promise<void> {
  await apiFetch(`/backends/${backendId}/auth/cancel?session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => {});
}

// --- Agents (full config) ---

export interface FullAgent {
  id: string;
  name: string;
  backend: string;
  model: string;
  credentials_id?: string | null;
  system_prompt?: string | null;
  temperature?: number;
  max_tokens?: number | null;
  effort?: string | null;
  mcp_servers?: string[];
  disabled_skills?: string[];
  [key: string]: unknown;
}

export interface ModelsResponse {
  models: Record<string, BackendModel[]>;
  constraints: Record<string, string[]>;
}

export async function fetchModelsWithConstraints(): Promise<ModelsResponse> {
  const data = await apiFetch<{ models: Record<string, { name: string; display_name?: string }[]>; constraints?: Record<string, string[]> }>("/models");
  const models: Record<string, BackendModel[]> = {};
  for (const [backend, list] of Object.entries(data.models || {})) {
    models[backend] = list.map((m) => ({ name: m.name || String(m), display_name: m.display_name || m.name || String(m) }));
  }
  return { models, constraints: data.constraints || {} };
}

export async function fetchFullAgents(team = "local"): Promise<FullAgent[]> {
  const data = await apiFetch<{ agents: FullAgent[] }>(`/agents?team=${team}`);
  return data.agents || [];
}

export async function getAgent(agentId: string): Promise<FullAgent | null> {
  try {
    return await apiFetch<FullAgent>(`/agents/${agentId}`);
  } catch {
    return null;
  }
}

export async function saveAgent(config: Partial<FullAgent> & { id: string; name: string }): Promise<FullAgent> {
  return apiFetch<FullAgent>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export async function deleteAgent(agentId: string, deleteSessions = false): Promise<void> {
  await apiFetch(`/agents/${agentId}?delete_sessions=${deleteSessions}`, { method: "DELETE" });
}

export async function fetchDefaultPrompt(model = "claude"): Promise<string> {
  try {
    const data = await apiFetch<{ prompt: string }>(`/agents/default-prompt?model=${model}`);
    return data.prompt || "";
  } catch {
    return "";
  }
}
