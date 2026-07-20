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

const DEFAULT_SERVER: ServerConfig = {
  // 127.0.0.1, not "localhost": on Windows localhost can resolve to IPv6 ::1
  // first, but the backend binds IPv4 127.0.0.1 only — so localhost fails to
  // connect there. 127.0.0.1 hits the exact bind address on every platform.
  url: "http://127.0.0.1:5000",
  name: "Local",
};

let currentServer: ServerConfig = DEFAULT_SERVER;

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${currentServer.url}/mux${path}`, options);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export function getServer(): ServerConfig {
  return currentServer;
}

export function setServer(config: ServerConfig) {
  currentServer = config;
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
  const res = await fetch(`${currentServer.url}/mux/channels/open-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  await fetch(`${currentServer.url}/mux/channels/${channelId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, team: activeTeam }),
  });
}

export async function getChannelConfig(channelId: string): Promise<Record<string, unknown>> {
  return apiFetch<Record<string, unknown>>(`/channels/${channelId}/config?team=${activeTeam}`);
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
  const wsUrl = currentServer.url.replace(/^http/, "ws");
  return new WebSocket(`${wsUrl}/mux/ws/channel/${channelId}`);
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
  await fetch(`${currentServer.url}/mux/streams/${streamId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function uploadImage(file: File, channelId?: string): Promise<{ url: string; filename: string }> {
  const formData = new FormData();
  formData.append("file", file);
  let url = `${currentServer.url}/mux/api/upload`;
  if (channelId) url += `?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return { url: `${currentServer.url}/mux${data.url}`, filename: data.filename };
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
