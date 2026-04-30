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
  url: "http://localhost:5000",
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

export async function checkConnection(): Promise<boolean> {
  try {
    await apiFetch("/agents");
    return true;
  } catch {
    return false;
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  const data = await apiFetch<{ agents: Agent[] }>("/agents");
  return data.agents;
}

export async function fetchChannels(): Promise<Channel[]> {
  const data = await apiFetch<{ channels: Channel[] }>("/channels/unread");
  return data.channels;
}

export async function createChannel(name: string): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function fetchChannelMessages(
  channelId: string,
  limit = 50,
): Promise<ChannelMessage[]> {
  const data = await apiFetch<{ messages: ChannelMessage[] }>(
    `/channels/${channelId}/messages?limit=${limit}`
  );
  return data.messages || [];
}

export async function postChannelMessage(
  channelId: string,
  content: string
): Promise<void> {
  await apiFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function openFolder(folderPath: string, name?: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${currentServer.url}/mux/channels/open-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder_path: folderPath, name }),
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
    body: JSON.stringify({}),
  });
}

export async function setChannelAgent(channelId: string, agentId: string): Promise<void> {
  await fetch(`${currentServer.url}/mux/channels/${channelId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
}

export async function getChannelConfig(channelId: string): Promise<Record<string, unknown>> {
  return apiFetch<Record<string, unknown>>(`/channels/${channelId}/config`);
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
