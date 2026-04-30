import {
  checkConnection,
  fetchAgents,
  fetchChannels,
  fetchChannelMessages,
  postChannelMessage,
  createChannelWebSocket,
  markChannelRead,
  openFolder,
  setChannelAgent,
  getChannelConfig,
  fetchModels,
  updateAgent,
  setHeartbeatEnabled,
  setSafeMode,
  getSafeMode,
  setInterrupt,
  clearInterrupt,
  getInterrupt,
  fetchUsage,
  cancelStream,
  uploadImage,
  getServer,
  type Agent,
  type Channel,
  type BackendModel,
  type UsageReport,
  type ThrottleState,
} from "./api";
import { open } from "@tauri-apps/plugin-dialog";
import { renderMarkdown } from "./markdown";

function loadLocalChannels(): Channel[] {
  try {
    return JSON.parse(localStorage.getItem("lit-desktop-channels") || "[]");
  } catch { return []; }
}

function saveLocalChannels() {
  localStorage.setItem("lit-desktop-channels", JSON.stringify(localChannels));
}

const messageInput = document.getElementById("message-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const messagesEl = document.getElementById("messages") as HTMLDivElement;
const channelList = document.getElementById("channel-list") as HTMLDivElement;
const channelTitle = document.getElementById("channel-title") as HTMLHeadingElement;
const channelActionsEl = document.getElementById("channel-actions") as HTMLDivElement;
const agentTabsEl = document.getElementById("agent-tabs") as HTMLDivElement;
const agentInfoEl = document.getElementById("agent-info") as HTMLDivElement;
const sidebarEl = document.getElementById("sidebar") as HTMLElement;
const sidebarResizeHandle = document.getElementById("sidebar-resize-handle") as HTMLDivElement;
const sidebarExpandBtn = document.getElementById("sidebar-expand-btn") as HTMLButtonElement;
const cancelStreamBtn = document.getElementById("cancel-stream-btn") as HTMLButtonElement;
const inputResizeHandle = document.getElementById("input-resize-handle") as HTMLDivElement;
const inputArea = document.getElementById("input-area") as HTMLDivElement;

let currentChannel: Channel | null = null;
let currentAgent: Agent | null = null;
let agents: Agent[] = [];
let channelWs: WebSocket | null = null;
let knownMessageIds = new Set<string>();
let localChannels: Channel[] = loadLocalChannels();
let userIsScrolledUp = false;
let streamingChannels = new Set<string>();
let activeStreamId: string | null = null;

// Agent control state
let backendModels: Record<string, BackendModel[]> = {};
let agentThrottles: Record<string, ThrottleState> = {};
let usageReports: Record<string, UsageReport> = {};

// Sidebar state
let sidebarWidth = parseInt(localStorage.getItem("lit-sidebar-width") || "240");
let sidebarOpen = localStorage.getItem("lit-sidebar-open") !== "false";

function initSidebar() {
  sidebarEl.style.width = sidebarWidth + "px";
  sidebarEl.style.minWidth = sidebarWidth + "px";
  if (!sidebarOpen) collapseSidebar();

  sidebarExpandBtn.addEventListener("click", expandSidebar);

  // Resize drag
  sidebarResizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(160, Math.min(400, startW + ev.clientX - startX));
      sidebarWidth = newW;
      sidebarEl.style.width = newW + "px";
      sidebarEl.style.minWidth = newW + "px";
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem("lit-sidebar-width", String(sidebarWidth));
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function collapseSidebar() {
  sidebarOpen = false;
  sidebarEl.classList.add("collapsed");
  sidebarResizeHandle.style.display = "none";
  sidebarExpandBtn.style.display = "";
  localStorage.setItem("lit-sidebar-open", "false");
}

function expandSidebar() {
  sidebarOpen = true;
  sidebarEl.classList.remove("collapsed");
  sidebarResizeHandle.style.display = "";
  sidebarExpandBtn.style.display = "none";
  localStorage.setItem("lit-sidebar-open", "true");
}

function setStatus(_state: "connected" | "disconnected" | "connecting") {
  // Connection state tracked internally; no visible status bar
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Tool call parsing ---

interface ToolCall {
  name: string;
  iconSvg: string;
  paramPreview: string;
  params: { key: string; value: string }[];
  result?: string;
}

interface ToolGroup {
  tools: ToolCall[];
}

interface ContentPart {
  type: "text" | "tool" | "tool-group" | "thinking";
  content?: string;
  tool?: ToolCall;
  toolGroup?: ToolGroup;
}

interface ParsedContent {
  parts: ContentPart[];
  links: string[];
}

const TOOL_ICONS: Record<string, string> = {
  Read: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 2H6c-1.206 0-3 .799-3 3v14c0 2.201 1.794 3 3 3h15v-2H6.012C5.55 19.988 5 19.806 5 19s.55-.988 1.012-1H21V4c0-1.103-.897-2-2-2zm0 14H5V5c0-.806.55-.988 1-1h13v12z"/></svg>',
  Write: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20.71 7.04c.39-.39.39-1.04 0-1.41l-2.34-2.34c-.37-.39-1.02-.39-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/></svg>',
  Edit: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20.71 7.04c.39-.39.39-1.04 0-1.41l-2.34-2.34c-.37-.39-1.02-.39-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/></svg>',
  Bash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 19V7H4v12h16m0-16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16m-7 14v-2h5v2h-5m-3.42-4L5.57 9H8.4l3.3 3.3c.39.39.39 1.03 0 1.42L8.42 17H5.59l4-4z"/></svg>',
  Grep: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  Glob: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  WebFetch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  WebSearch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  Task: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2M7.5 13A2.5 2.5 0 0 0 5 15.5 2.5 2.5 0 0 0 7.5 18a2.5 2.5 0 0 0 2.5-2.5A2.5 2.5 0 0 0 7.5 13zm9 0a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0 2.5-2.5 2.5 2.5 0 0 0-2.5-2.5z"/></svg>',
  TodoWrite: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
  LSP: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
  AskUserQuestion: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>',
  ScheduleWakeup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>',
  Skill: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 5h10v2h2V3c0-1.1-.9-2-2-2H7c-1.1 0-2 .9-2 2v4h2V5zm8.41 11.59L20 12l-4.59-4.59L14 8.83 17.17 12 14 15.17l1.41 1.42zM10 15.17L6.83 12 10 8.83 8.59 7.41 4 12l4.59 4.59L10 15.17zM17 19H7v-2H5v4c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-4h-2v2z"/></svg>',
  default: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>',
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || TOOL_ICONS.default;
}

function getParamPreview(name: string, input: Record<string, unknown>): string {
  if (name === "ScheduleWakeup") {
    const delay = (input.delaySeconds || input.delay_seconds) as number;
    const reason = (input.reason || "") as string;
    if (delay) {
      const fireAt = new Date(Date.now() + delay * 1000);
      const timeStr = fireAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const mins = Math.round(delay / 60);
      return `: waking at ${timeStr} (in ${mins}m)${reason ? " — " + reason : ""}`;
    }
  }
  const primaryKeys = ["description", "file_path", "command", "pattern", "prompt", "content", "query"];
  for (const key of primaryKeys) {
    if (input[key]) {
      const val = typeof input[key] === "string" ? input[key] as string : JSON.stringify(input[key]);
      return `: ${val.length > 60 ? val.substring(0, 60) + "…" : val}`;
    }
  }
  return "";
}

function hasToolDelimiters(content: string): boolean {
  if (content.includes("\x02TOOLJSON")) return true;
  if (content.includes("[THINKING]")) return true;
  if (/(?<!`)\[TOOL_START\]🔧 Tool:/.test(content)) return true;
  return false;
}

function parseMessageContent(raw: string): ParsedContent {
  const links: string[] = [];

  // Extract LINKS line
  const linksMatch = raw.match(/^LINKS:\s*(.+)$/m);
  if (linksMatch) {
    const linkRefs = linksMatch[1].match(/\[\[([^\]]+)\]\]/g) || [];
    for (const ref of linkRefs) {
      links.push(ref.replace(/\[\[|\]\]/g, ""));
    }
  }

  // Remove heartbeat artifacts and context envelopes
  let content = raw
    .replace(/<context>[\s\S]*?<\/context>\s*/g, "")
    .replace(/SLEEP_MODE:.*$/gm, "")
    .replace(/^REACT:.*$/gm, "")
    .replace(/^LINKS:.*$/gm, "")
    .trim();

  if (!hasToolDelimiters(content)) {
    // Strip thinking for non-tool messages
    content = content
      .replace(/\[THINKING\][\s\S]*?\[\/THINKING\]/g, "")
      .replace(/\[\/?THINKING\]/g, "")
      .trim();
    const parts: ContentPart[] = content ? [{ type: "text", content }] : [];
    return { parts, links };
  }

  // Walk content character-by-character, extracting tool calls, results, thinking
  const rawParts: ContentPart[] = [];
  let currentPos = 0;
  let lastToolCall: ToolCall | null = null;

  while (currentPos < content.length) {
    const jsonStart = content.indexOf("\x02TOOLJSON", currentPos);
    const resultStart = content.indexOf("[TOOL_RESULT]", currentPos);
    const thinkingStart = content.indexOf("[THINKING]", currentPos);

    const candidates = [
      { pos: jsonStart, type: "json" as const },
      { pos: resultStart, type: "result" as const },
      { pos: thinkingStart, type: "thinking" as const },
    ].filter((c) => c.pos !== -1).sort((a, b) => a.pos - b.pos);

    if (candidates.length === 0) {
      const remaining = content.slice(currentPos).trim();
      if (remaining) rawParts.push({ type: "text", content: remaining });
      break;
    }

    const next = candidates[0];

    if (next.pos > currentPos) {
      const textContent = content.slice(currentPos, next.pos).trim();
      if (textContent) rawParts.push({ type: "text", content: textContent });
    }

    if (next.type === "json") {
      const startTag = "\x02TOOLJSON";
      const jsonEnd = content.indexOf("\x03", next.pos);
      if (jsonEnd === -1) break;

      const jsonStr = content.slice(next.pos + startTag.length, jsonEnd).trim();
      if (jsonStr) {
        try {
          const data = JSON.parse(jsonStr);
          const toolName: string = data.name || "Unknown";
          const toolInput: Record<string, unknown> = data.input || {};

          const params: { key: string; value: string }[] = [];
          for (const [key, value] of Object.entries(toolInput)) {
            params.push({
              key,
              value: typeof value === "string" ? value : JSON.stringify(value),
            });
          }

          const tool: ToolCall = {
            name: toolName,
            iconSvg: getToolIcon(toolName),
            paramPreview: getParamPreview(toolName, toolInput),
            params,
          };
          lastToolCall = tool;
          rawParts.push({ type: "tool", tool });
        } catch {
          // malformed JSON — skip
        }
      }
      currentPos = jsonEnd + 1;
    } else if (next.type === "result") {
      const resultEnd = content.indexOf("[/TOOL_RESULT]", next.pos + "[TOOL_RESULT]".length);
      if (resultEnd === -1) break;

      const resultContent = content.slice(next.pos + "[TOOL_RESULT]".length, resultEnd).trim();
      if (lastToolCall) {
        lastToolCall.result = resultContent;
        lastToolCall = null;
      }
      currentPos = resultEnd + "[/TOOL_RESULT]".length;
    } else if (next.type === "thinking") {
      const thinkingEnd = content.indexOf("[/THINKING]", next.pos + "[THINKING]".length);
      if (thinkingEnd === -1) break;

      const thinkingContent = content.slice(next.pos + "[THINKING]".length, thinkingEnd).trim();
      if (thinkingContent) rawParts.push({ type: "thinking", content: thinkingContent });
      currentPos = thinkingEnd + "[/THINKING]".length;
    }
  }

  // Second pass: group consecutive tool parts into tool-groups
  const grouped: ContentPart[] = [];
  let i = 0;
  while (i < rawParts.length) {
    if (rawParts[i].type === "tool") {
      const tools: ToolCall[] = [];
      while (i < rawParts.length && rawParts[i].type === "tool") {
        tools.push(rawParts[i].tool!);
        i++;
      }
      grouped.push({ type: "tool-group", toolGroup: { tools } });
    } else {
      grouped.push(rawParts[i]);
      i++;
    }
  }

  return { parts: grouped, links };
}

function hasVisibleContent(parsed: ParsedContent): boolean {
  return parsed.parts.some((p) => {
    if (p.type === "text") return (p.content || "").length > 0;
    return true;
  });
}

// --- Tool rendering ---

const CHEVRON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>';

function renderToolCallEl(tool: ToolCall): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "tool-call";

  const summary = document.createElement("div");
  summary.className = "tool-summary";
  const spinnerHtml = !tool.result ? `<span class="tool-spinner"></span>` : "";
  summary.innerHTML = `<span class="tool-icon">${tool.iconSvg}</span><span class="tool-name">${escapeHtml(tool.name)}</span><span class="tool-param-preview">${escapeHtml(tool.paramPreview)}</span>${spinnerHtml}<span class="tool-expand-icon">${CHEVRON_SVG}</span>`;
  el.appendChild(summary);

  const details = document.createElement("div");
  details.className = "tool-details";
  details.style.display = "none";

  if (tool.params.length > 0) {
    const paramsSection = document.createElement("div");
    paramsSection.className = "tool-params-section";
    paramsSection.innerHTML = "<strong>Parameters:</strong>";
    for (const param of tool.params) {
      const paramEl = document.createElement("div");
      paramEl.className = "tool-param";
      paramEl.innerHTML = `<span class="param-key">${escapeHtml(param.key)}:</span> <span class="param-value">${escapeHtml(param.value)}</span>`;
      paramsSection.appendChild(paramEl);
    }
    details.appendChild(paramsSection);
  }

  const resultSection = document.createElement("div");
  resultSection.className = "tool-result-section";
  resultSection.innerHTML = "<strong>Result:</strong>";
  const resultContent = document.createElement("div");
  resultContent.className = "tool-result-content";
  if (tool.result) {
    resultContent.innerHTML = `<pre>${escapeHtml(tool.result)}</pre>`;
  } else {
    resultContent.innerHTML = "<em>No result</em>";
  }
  resultSection.appendChild(resultContent);
  details.appendChild(resultSection);

  el.appendChild(details);

  summary.addEventListener("click", () => {
    const isOpen = details.style.display !== "none";
    details.style.display = isOpen ? "none" : "";
    el.classList.toggle("open", !isOpen);
    el.querySelector(".tool-expand-icon")?.classList.toggle("rotated", !isOpen);
  });

  return el;
}

function renderToolGroupEl(group: ToolGroup): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "tool-group";

  const header = document.createElement("div");
  header.className = "tool-group-header";

  const iconsSpan = document.createElement("span");
  iconsSpan.className = "tool-group-icons";
  for (const tool of group.tools) {
    const icon = document.createElement("span");
    icon.className = "tool-group-icon";
    icon.innerHTML = tool.iconSvg;
    icon.title = tool.name;
    iconsSpan.appendChild(icon);
  }
  header.appendChild(iconsSpan);

  const hasPending = group.tools.some(t => !t.result);

  const label = document.createElement("span");
  label.className = "tool-group-label";
  label.textContent = `${group.tools.length} action${group.tools.length !== 1 ? "s" : ""}`;
  header.appendChild(label);

  if (hasPending) {
    const spinner = document.createElement("span");
    spinner.className = "tool-spinner";
    header.appendChild(spinner);
  }

  const toggle = document.createElement("span");
  toggle.className = "tool-group-toggle";
  toggle.innerHTML = CHEVRON_SVG;
  header.appendChild(toggle);

  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "tool-group-body";
  body.style.display = "none";
  for (const tool of group.tools) {
    body.appendChild(renderToolCallEl(tool));
  }
  el.appendChild(body);

  header.addEventListener("click", () => {
    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "";
    toggle.classList.toggle("open", !isOpen);
    iconsSpan.style.display = isOpen ? "" : "none";
    label.textContent = isOpen
      ? `${group.tools.length} action${group.tools.length !== 1 ? "s" : ""}`
      : "";
  });

  return el;
}

function renderContentParts(parent: HTMLElement, parts: ContentPart[], role: string) {
  for (const part of parts) {
    if (part.type === "text") {
      const content = document.createElement("div");
      content.className = "message-content";
      if (role === "user" && !(part.content || "").includes("![")) {
        content.innerHTML = `<p>${escapeHtml(part.content || "").replace(/\n/g, "<br>")}</p>`;
      } else {
        content.innerHTML = renderMarkdown(part.content || "");
      }
      parent.appendChild(content);
    } else if (part.type === "tool-group" && part.toolGroup) {
      parent.appendChild(renderToolGroupEl(part.toolGroup));
    } else if (part.type === "tool" && part.tool) {
      parent.appendChild(renderToolCallEl(part.tool));
    } else if (part.type === "thinking") {
      const el = document.createElement("div");
      el.className = "thinking-content";
      el.innerHTML = renderMarkdown(part.content || "");
      parent.appendChild(el);
    }
  }
}

// --- Scroll management ---

function isNearBottom(): boolean {
  const threshold = 80;
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  userIsScrolledUp = false;
  updateScrollButton();
}

function updateScrollButton() {
  const btn = document.getElementById("scroll-to-bottom");
  if (!btn) return;
  if (userIsScrolledUp) {
    btn.classList.add("visible");
  } else {
    btn.classList.remove("visible");
  }
}

messagesEl.addEventListener("scroll", () => {
  userIsScrolledUp = !isNearBottom();
  updateScrollButton();
});

// --- Context menu (kebab) ---

interface MenuItem {
  label: string;
  action: () => void;
  type?: "action" | "info" | "danger" | "separator";
}

function showContextMenu(event: MouseEvent, items: MenuItem[]) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  for (const item of items) {
    if (item.type === "separator") {
      const sep = document.createElement("div");
      sep.className = "context-menu-divider";
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = "context-menu-item";
    if (item.type === "info") row.classList.add("info");
    if (item.type === "danger") row.classList.add("danger");
    row.textContent = item.label;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const menuWidth = 220;
  const x = Math.min(event.clientX, window.innerWidth - menuWidth);
  const y = Math.min(event.clientY, window.innerHeight - items.length * 32 - 8);
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  setTimeout(() => {
    document.addEventListener("click", closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  document.querySelectorAll(".context-menu").forEach((el) => el.remove());
}

// --- Message header item system (favorites + reorder, matching web app) ---

interface RenderableMessage {
  role: string;
  content: string;
  id?: string;
  from?: string;
  timestamp?: string;
  file_path?: string;
  metadata?: Record<string, unknown>;
}

const HEADER_ITEMS_DEFAULT_ORDER = ["timestamp", "duration", "copy", "path", "session", "delete"];
const HEADER_ITEMS_DEFAULT_FAVS = ["timestamp"];

const HEADER_ITEM_LABELS: Record<string, string> = {
  timestamp: "Timestamp", duration: "Response time", copy: "Copy content",
  path: "Copy path", session: "Copy session ID", delete: "Delete",
};

const HEADER_ITEM_ICONS: Record<string, string> = {
  timestamp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>',
  duration: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.962 8.962 0 0 0 12 4c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>',
  copy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  path: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  session: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0A6.954 6.954 0 0 0 19 12.53h2c0 1.55-.44 3.03-1.25 4.35-2.39 3.9-7.46 5.14-11.33 2.76S3.28 12.17 5.67 8.28c2.39-3.9 7.46-5.14 11.33-2.76l.11.08 2.47-2.53V10.12z"/></svg>',
  delete: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
};

function loadHeaderFavorites(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("lit-desktop-header-favs") || "null") || HEADER_ITEMS_DEFAULT_FAVS);
  } catch { return new Set(HEADER_ITEMS_DEFAULT_FAVS); }
}

function loadHeaderOrder(): string[] {
  try {
    const stored: string[] = JSON.parse(localStorage.getItem("lit-desktop-header-order") || "null");
    if (stored) {
      const missing = HEADER_ITEMS_DEFAULT_ORDER.filter((id) => !stored.includes(id));
      return [...stored, ...missing];
    }
  } catch { /* use default */ }
  return [...HEADER_ITEMS_DEFAULT_ORDER];
}

let headerFavorites = loadHeaderFavorites();
let headerItemOrder = loadHeaderOrder();

function saveHeaderPrefs() {
  localStorage.setItem("lit-desktop-header-favs", JSON.stringify([...headerFavorites]));
  localStorage.setItem("lit-desktop-header-order", JSON.stringify(headerItemOrder));
}

function isItemVisible(id: string, msg: RenderableMessage): boolean {
  const meta = msg.metadata || {};
  switch (id) {
    case "timestamp": return !!msg.timestamp;
    case "duration": return !!meta.total_ms;
    case "copy": return true;
    case "path": return !!msg.file_path;
    case "session": return !!meta.session_id;
    case "delete": return !!msg.id;
    default: return false;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function getItemBadgeHtml(id: string, msg: RenderableMessage): string {
  const meta = msg.metadata || {};
  const icon = HEADER_ITEM_ICONS[id] || "";
  switch (id) {
    case "timestamp":
      return msg.timestamp
        ? escapeHtml(new Date(msg.timestamp).toLocaleString())
        : "";
    case "duration": {
      const total = formatDuration(Number(meta.total_ms));
      const ttfb = meta.ttfb_ms ? ` (TTFB ${formatDuration(Number(meta.ttfb_ms))})` : "";
      return `${icon} ${escapeHtml(total + ttfb)}`;
    }
    case "copy": return icon;
    case "path": return icon;
    case "session": return `${icon} ${escapeHtml(String(meta.session_id || "").substring(0, 8))}`;
    case "delete": return icon;
    default: return "";
  }
}

function getItemMenuLabel(id: string, msg: RenderableMessage): string {
  const meta = msg.metadata || {};
  switch (id) {
    case "timestamp":
      return msg.timestamp ? `Timestamp: ${new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Timestamp";
    case "duration": {
      const total = formatDuration(Number(meta.total_ms));
      const ttfb = meta.ttfb_ms ? ` (TTFB ${formatDuration(Number(meta.ttfb_ms))})` : "";
      return `Response: ${total}${ttfb}`;
    }
    case "session": return `Session: ${String(meta.session_id || "").substring(0, 8)}`;
    default: return HEADER_ITEM_LABELS[id] || id;
  }
}

function executeItemAction(id: string, msg: RenderableMessage, el: HTMLElement, parsed: ParsedContent) {
  switch (id) {
    case "timestamp":
      if (msg.timestamp) navigator.clipboard.writeText(msg.timestamp).catch(() => {});
      break;
    case "copy": {
      const textParts = parsed.parts.filter((s) => s.type === "text").map((s) => s.content || "");
      navigator.clipboard.writeText(textParts.join("\n")).catch(() => {});
      break;
    }
    case "path":
      if (msg.file_path) navigator.clipboard.writeText(msg.file_path).catch(() => {});
      break;
    case "session": {
      const sid = String((msg.metadata || {}).session_id || "");
      if (sid) navigator.clipboard.writeText(sid).catch(() => {});
      break;
    }
    case "delete":
      if (currentChannel && msg.id) deleteMessage(currentChannel.id, msg.id, el);
      break;
  }
}

// Store msg data per element so we can re-render headers after pref changes
const msgDataMap = new WeakMap<HTMLElement, { msg: RenderableMessage; parsed: ParsedContent }>();

function renderHeaderFavorites(header: HTMLElement, msg: RenderableMessage, el: HTMLElement, parsed: ParsedContent) {
  // Remove existing favorites and kebab (keep author + spacer)
  header.querySelectorAll(".header-fav, .kebab-btn").forEach((n) => n.remove());

  const kebabBtn = document.createElement("button");
  kebabBtn.className = "kebab-btn";
  kebabBtn.title = "More";
  kebabBtn.innerHTML = "&#8942;";
  kebabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showHeaderMenu(e as MouseEvent, msg, el, parsed);
  });

  for (const itemId of headerItemOrder) {
    if (!headerFavorites.has(itemId) || !isItemVisible(itemId, msg)) continue;
    const badge = document.createElement("span");
    badge.className = `header-fav fav-${itemId}`;
    badge.innerHTML = getItemBadgeHtml(itemId, msg);
    badge.title = HEADER_ITEM_LABELS[itemId] || itemId;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      executeItemAction(itemId, msg, el, parsed);
    });
    header.insertBefore(badge, null);
  }

  header.appendChild(kebabBtn);
}

function refreshAllHeaders() {
  messagesEl.querySelectorAll(".message").forEach((msgEl) => {
    const data = msgDataMap.get(msgEl as HTMLElement);
    if (!data) return;
    const header = msgEl.querySelector(".message-header") as HTMLElement;
    if (header) renderHeaderFavorites(header, data.msg, msgEl as HTMLElement, data.parsed);
  });
}

function showHeaderMenu(event: MouseEvent, msg: RenderableMessage, msgEl: HTMLElement, parsed: ParsedContent) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu header-menu";

  for (let i = 0; i < headerItemOrder.length; i++) {
    const itemId = headerItemOrder[i];
    if (!isItemVisible(itemId, msg)) continue;

    const row = document.createElement("div");
    row.className = "context-menu-item header-menu-item";
    if (itemId === "delete") row.classList.add("danger");

    const label = document.createElement("span");
    label.className = "hmi-label";
    const iconHtml = HEADER_ITEM_ICONS[itemId] || "";
    label.innerHTML = `${iconHtml} ${escapeHtml(getItemMenuLabel(itemId, msg))}`;
    row.appendChild(label);

    const controls = document.createElement("span");
    controls.className = "hmi-controls";

    // Reorder up
    const upBtn = document.createElement("span");
    upBtn.className = `reorder-arrow${i === 0 ? " disabled" : ""}`;
    upBtn.textContent = "▲";
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = headerItemOrder.indexOf(itemId);
      if (idx > 0) {
        [headerItemOrder[idx], headerItemOrder[idx - 1]] = [headerItemOrder[idx - 1], headerItemOrder[idx]];
        saveHeaderPrefs();
        refreshAllHeaders();
        showHeaderMenu(event, msg, msgEl, parsed);
      }
    });
    controls.appendChild(upBtn);

    // Reorder down
    const downBtn = document.createElement("span");
    downBtn.className = `reorder-arrow${i === headerItemOrder.length - 1 ? " disabled" : ""}`;
    downBtn.textContent = "▼";
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = headerItemOrder.indexOf(itemId);
      if (idx < headerItemOrder.length - 1) {
        [headerItemOrder[idx], headerItemOrder[idx + 1]] = [headerItemOrder[idx + 1], headerItemOrder[idx]];
        saveHeaderPrefs();
        refreshAllHeaders();
        showHeaderMenu(event, msg, msgEl, parsed);
      }
    });
    controls.appendChild(downBtn);

    // Star toggle
    const star = document.createElement("span");
    star.className = "fav-star";
    star.textContent = headerFavorites.has(itemId) ? "★" : "☆";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      if (headerFavorites.has(itemId)) {
        headerFavorites.delete(itemId);
      } else {
        headerFavorites.add(itemId);
      }
      saveHeaderPrefs();
      refreshAllHeaders();
      showHeaderMenu(event, msg, msgEl, parsed);
    });
    controls.appendChild(star);

    row.appendChild(controls);

    // Click the row to execute the action
    row.addEventListener("click", () => {
      closeContextMenu();
      executeItemAction(itemId, msg, msgEl, parsed);
    });

    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  const menuWidth = 280;
  const x = Math.min(event.clientX, window.innerWidth - menuWidth);
  const y = Math.min(event.clientY, window.innerHeight - headerItemOrder.length * 36 - 8);
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  setTimeout(() => {
    document.addEventListener("click", closeContextMenu, { once: true });
  }, 0);
}

// --- Message rendering ---

function renderMessage(msg: RenderableMessage) {
  const parsed = parseMessageContent(msg.content);
  if (!hasVisibleContent(parsed)) return null;

  const el = document.createElement("div");
  el.className = `message ${msg.role}`;
  if (msg.id) el.dataset.messageId = msg.id;

  // Header
  const header = document.createElement("div");
  header.className = "message-header";
  const who = msg.role === "user" ? "You" : (msg.from || currentAgent?.name || "Agent");

  const authorSpan = document.createElement("span");
  authorSpan.className = "message-author";
  authorSpan.textContent = who;
  header.appendChild(authorSpan);

  const spacer = document.createElement("span");
  spacer.className = "header-spacer";
  header.appendChild(spacer);

  // Render promoted favorites + kebab, and store data for live refresh
  if (msg.role !== "system" && msg.id) {
    msgDataMap.set(el, { msg, parsed });
    renderHeaderFavorites(header, msg, el, parsed);
  }

  el.appendChild(header);

  // Content parts
  renderContentParts(el, parsed.parts, msg.role);

  // Knowledge graph links
  if (parsed.links.length > 0) {
    const linksRow = document.createElement("div");
    linksRow.className = "links-row";
    for (const link of parsed.links) {
      const tag = document.createElement("span");
      tag.className = "link-tag";
      tag.textContent = `#${link.split("/").pop()}`;
      tag.title = link;
      linksRow.appendChild(tag);
    }
    el.appendChild(linksRow);
  }

  messagesEl.appendChild(el);

  if (!userIsScrolledUp) {
    scrollToBottom();
  } else {
    updateScrollButton();
  }

  return el;
}

function clearMessages() {
  messagesEl.innerHTML = "";
  knownMessageIds.clear();
  userIsScrolledUp = false;
  updateScrollButton();
}

function mergeChannels(local: Channel[], remote: Channel[]): Channel[] {
  const map = new Map<string, Channel>();
  for (const ch of local) map.set(ch.id, ch);
  for (const ch of remote) map.set(ch.id, ch);
  return Array.from(map.values());
}

// --- Agent tabs ---

function getPresenceClass(agent: Agent): string {
  const throttle = agentThrottles[agent.id];
  if (throttle === "disabled") return "offline";
  if (throttle === "stopped") return "stopped";
  if (agent.status === "busy") return "busy";
  return "idle";
}

const THROTTLE_SVG: Record<ThrottleState, string> = {
  disabled: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21C12 21 4 15 4 9.5a4.5 4.5 0 019-1 4.5 4.5 0 019 1C22 15 12 21 12 21z"/></svg>`,
  enabled: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none"><path d="M12 21C12 21 4 15 4 9.5a4.5 4.5 0 019-1 4.5 4.5 0 019 1C22 15 12 21 12 21z"/></svg>`,
  safe: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z"/></svg>`,
  stopped: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="10"/><rect x="9" y="8" width="2" height="8" rx="1"/><rect x="13" y="8" width="2" height="8" rx="1"/></svg>`,
};

const THROTTLE_COLOR: Record<ThrottleState, string> = {
  disabled: "var(--text-muted)",
  enabled: "#4caf50",
  safe: "#ff9800",
  stopped: "#e06c75",
};

const THROTTLE_LABEL: Record<ThrottleState, string> = {
  disabled: "Disabled",
  enabled: "Enabled",
  safe: "Safe mode",
  stopped: "Paused",
};

const EFFORT_LEVELS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function renderAgentTabs() {
  agentTabsEl.innerHTML = "";

  for (const agent of agents) {
    const tab = document.createElement("div");
    tab.className = "agent-tab";
    if (currentAgent?.id === agent.id) tab.classList.add("active");

    const presenceClass = getPresenceClass(agent);
    tab.innerHTML = `<span class="status-indicator ${presenceClass}"></span><span>${escapeHtml(agent.name)}</span>`;

    tab.addEventListener("click", () => selectAgent(agent));
    agentTabsEl.appendChild(tab);
  }

  const addBtn = document.createElement("div");
  addBtn.className = "agent-tab-add";
  addBtn.textContent = "+";
  addBtn.title = "Add agent";
  agentTabsEl.appendChild(addBtn);
}

function renderAgentInfo() {
  if (!currentAgent) {
    agentInfoEl.innerHTML = "";
    return;
  }

  const agent = currentAgent;
  const throttle = agentThrottles[agent.id] || "disabled";
  const models = backendModels[agent.backend] || [];
  const usage = usageReports[agent.backend];

  agentInfoEl.innerHTML = "";

  // Throttle icon button
  const throttleBtn = document.createElement("button");
  throttleBtn.className = `agent-ctrl-btn throttle-btn throttle-${throttle}`;
  throttleBtn.title = THROTTLE_LABEL[throttle];
  throttleBtn.innerHTML = THROTTLE_SVG[throttle];
  throttleBtn.style.color = THROTTLE_COLOR[throttle];
  throttleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showThrottleMenu(e, agent, throttle);
  });
  agentInfoEl.appendChild(throttleBtn);

  // Settings icon button
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "agent-ctrl-btn settings-btn";
  settingsBtn.title = "Agent settings";
  settingsBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`;
  agentInfoEl.appendChild(settingsBtn);

  // Model selector button (flat text + chevron, opens dropdown)
  const modelBtn = document.createElement("button");
  modelBtn.className = "agent-model-btn";
  const displayName = getModelDisplayName(agent.model);
  const effortHtml = agent.effort ? `<span class="effort-badge">${escapeHtml(agent.effort)}</span>` : "";
  modelBtn.innerHTML = `<span class="model-label">${escapeHtml(displayName)}</span>${effortHtml}<svg class="model-chevron" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>`;
  if (models.length > 1 || agent.backend === "claude-cli") {
    modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showModelMenu(e, agent, models);
    });
  } else {
    modelBtn.style.cursor = "default";
  }
  agentInfoEl.appendChild(modelBtn);

  // Usage bars (filter out Sonnet quota when a non-Sonnet model is selected)
  if (usage?.available && usage.quotas.length > 0) {
    const isSonnet = agent.model.toLowerCase().includes("sonnet");
    const relevantQuotas = usage.quotas.filter((q) => isSonnet || q.name.toLowerCase() !== "sonnet");
    if (relevantQuotas.length > 0) {
      const tooltipLines = relevantQuotas.map((q) => `${q.name}: ${Math.round(q.used * 100)}%`).join("\n");
      const barsDiv = document.createElement("div");
      barsDiv.className = "usage-bars-inline";
      barsDiv.title = tooltipLines;
      for (const quota of relevantQuotas) {
        const pct = Math.round(quota.used * 100);
        const usageClass = pct > 80 ? "usage-critical" : pct > 50 ? "usage-warning" : "usage-normal";
        barsDiv.innerHTML += `<div class="usage-bar-strip"><div class="usage-bar-fill ${usageClass}" style="width: ${pct}%"></div></div>`;
      }
      agentInfoEl.appendChild(barsDiv);
    }
  }
}

function showThrottleMenu(event: MouseEvent, agent: Agent, current: ThrottleState) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu throttle-menu";

  const states: ThrottleState[] = ["disabled", "enabled", "safe", "stopped"];
  for (const state of states) {
    const row = document.createElement("div");
    row.className = "context-menu-item throttle-menu-item";
    if (state === current) row.classList.add("active");
    row.innerHTML = `<span class="throttle-menu-icon" style="color:${THROTTLE_COLOR[state]}">${THROTTLE_SVG[state]}</span><span>${THROTTLE_LABEL[state]}</span>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      applyThrottle(agent, state);
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  positionMenuNear(menu, event);
  setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 0);
}

function showModelMenu(event: MouseEvent, agent: Agent, models: BackendModel[]) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu model-menu";

  // Model section
  if (models.length > 1) {
    const label = document.createElement("div");
    label.className = "context-menu-item info menu-section-label";
    label.textContent = "Model";
    menu.appendChild(label);

    for (const m of models) {
      const row = document.createElement("div");
      row.className = "context-menu-item model-menu-item";
      if (m.name === agent.model) row.classList.add("active");
      row.innerHTML = `<span>${escapeHtml(m.display_name)}</span>${m.name === agent.model ? '<svg class="check-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ""}`;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        changeModel(agent, m.name);
      });
      menu.appendChild(row);
    }
  }

  // Effort section (only for claude-cli)
  if (agent.backend === "claude-cli") {
    const sep = document.createElement("div");
    sep.className = "context-menu-divider";
    menu.appendChild(sep);

    const label = document.createElement("div");
    label.className = "context-menu-item info menu-section-label";
    label.textContent = "Effort";
    menu.appendChild(label);

    for (const e of EFFORT_LEVELS) {
      const row = document.createElement("div");
      row.className = "context-menu-item model-menu-item";
      if ((agent.effort || "") === e.value) row.classList.add("active");
      row.innerHTML = `<span>${escapeHtml(e.label)}</span>${(agent.effort || "") === e.value ? '<svg class="check-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ""}`;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeContextMenu();
        changeEffort(agent, e.value);
      });
      menu.appendChild(row);
    }
  }

  document.body.appendChild(menu);
  positionMenuNear(menu, event);
  setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 0);
}

function positionMenuNear(menu: HTMLElement, event: MouseEvent) {
  const btn = (event.currentTarget || event.target) as HTMLElement;
  const rect = btn.getBoundingClientRect();
  const maxH = window.innerHeight - 16;
  menu.style.maxHeight = maxH + "px";
  menu.style.overflowY = "auto";
  void menu.offsetHeight;
  const menuRect = menu.getBoundingClientRect();
  const x = Math.min(rect.left, window.innerWidth - menuRect.width - 8);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const y = spaceBelow >= menuRect.height
    ? rect.bottom + 4
    : Math.max(8, rect.top - menuRect.height - 4);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
}

async function changeEffort(agent: Agent, effort: string) {
  try {
    await updateAgent(agent.id, { effort: effort || null } as Partial<Agent>);
    agent.effort = effort || null;
    renderAgentInfo();
  } catch (err) {
    console.error("Failed to change effort:", err);
  }
}

function getModelDisplayName(model: string): string {
  for (const models of Object.values(backendModels)) {
    const found = models.find((m) => m.name === model);
    if (found) return found.display_name;
  }
  return model;
}


async function applyThrottle(agent: Agent, state: ThrottleState) {
  const prev = agentThrottles[agent.id] || "disabled";
  try {
    // Tear down previous state
    if (prev === "stopped") await clearInterrupt(agent.id);
    if (prev === "safe") await setSafeMode(agent.id, false);

    // Enable/disable transitions
    const wasEnabled = prev !== "disabled";
    const willEnable = state !== "disabled";
    if (!wasEnabled && willEnable) {
      await setHeartbeatEnabled(agent.id, true);
      agent.heartbeat_enabled = true;
    } else if (wasEnabled && !willEnable) {
      await setHeartbeatEnabled(agent.id, false);
      agent.heartbeat_enabled = false;
    }

    // Set up new state
    if (state === "safe") await setSafeMode(agent.id, true);
    if (state === "stopped") await setInterrupt(agent.id, "User paused from desktop app");

    agentThrottles[agent.id] = state;
  } catch (err) {
    console.error("Failed to set throttle:", err);
  }
  renderAgentTabs();
  renderAgentInfo();
}

async function changeModel(agent: Agent, model: string) {
  try {
    await updateAgent(agent.id, { model });
    agent.model = model;
    renderAgentInfo();
  } catch (err) {
    console.error("Failed to change model:", err);
  }
}

async function loadAgentThrottle(agent: Agent) {
  if (!agent.heartbeat_enabled) {
    agentThrottles[agent.id] = "disabled";
    return;
  }
  try {
    const [safeResp, intResp] = await Promise.all([
      getSafeMode(agent.id),
      getInterrupt(agent.id),
    ]);
    const safe = safeResp?.safe_mode ?? false;
    const interrupted = intResp?.interrupt_requested ?? false;
    agentThrottles[agent.id] = interrupted ? "stopped" : safe ? "safe" : "enabled";
  } catch {
    agentThrottles[agent.id] = "enabled";
  }
}

async function selectAgent(agent: Agent) {
  currentAgent = agent;
  localStorage.setItem("lit-desktop-agent", agent.id);
  await loadAgentThrottle(agent);
  renderAgentTabs();
  renderAgentInfo();

  if (currentChannel) {
    try {
      await setChannelAgent(currentChannel.id, agent.id);
    } catch {
      // Non-critical
    }
  }
}

async function loadChannelAgent(channelId: string) {
  try {
    const config = await getChannelConfig(channelId);
    const agentId = config.agent_id as string | null;
    if (agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) {
        currentAgent = agent;
        localStorage.setItem("lit-desktop-agent", agent.id);
        renderAgentTabs();
        renderAgentInfo();
        return;
      }
    }
  } catch {
    // Config might not exist yet
  }

  if (agents.length > 0 && !currentAgent) {
    currentAgent = agents[0];
    renderAgentTabs();
    renderAgentInfo();
  }
}

// --- Folder opening ---

async function handleOpenFolder() {
  const selected = await open({ directory: true, title: "Open project folder" });
  if (!selected) return;

  const folderPath = typeof selected === "string" ? selected : selected;
  try {
    const result = await openFolder(folderPath);
    const newChannel: Channel = {
      id: result.id || result.name,
      name: result.name,
      unreadCount: 0,
    };
    if (!localChannels.find((c) => c.id === newChannel.id)) {
      localChannels.push(newChannel);
      saveLocalChannels();
    }
    renderSidebar(mergeChannels(localChannels, await fetchChannels()));
    await openChannel(newChannel);
  } catch (err) {
    renderMessage({ role: "system", content: `Failed to open folder: ${err}` });
  }
}

// --- Sidebar ---

function renderSidebar(channels: Channel[]) {
  channelList.innerHTML = "";

  // Section header with add menu
  const header = document.createElement("div");
  header.className = "section-header";
  header.innerHTML = `<span class="section-label">Channels</span><button class="icon-btn section-add-btn" title="Open folder">+</button>`;
  header.querySelector(".section-add-btn")!.addEventListener("click", handleOpenFolder);
  channelList.appendChild(header);

  for (const ch of channels) {
    const item = document.createElement("div");
    item.className = "channel-item";
    item.dataset.channelId = ch.id;
    if (currentChannel?.id === ch.id) item.classList.add("active");

    const isStreaming = streamingChannels.has(ch.id);
    const hasUnread = ch.unreadCount > 0 && currentChannel?.id !== ch.id;

    let indicators = "";
    if (isStreaming) {
      indicators += `<span class="channel-dot streaming" title="Streaming"></span>`;
    } else if (hasUnread) {
      indicators += `<span class="channel-dot unread" title="${ch.unreadCount} unread"></span>`;
    }

    const badge = hasUnread ? `<span class="unread-badge">${ch.unreadCount}</span>` : "";
    item.innerHTML = `<span class="channel-icon">#</span><span class="channel-name">${escapeHtml(ch.name)}</span>${indicators}${badge}`;
    item.addEventListener("click", () => openChannel(ch));
    channelList.appendChild(item);
  }

  if (channels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No channels yet";
    channelList.appendChild(empty);
  }
}

function renderSidebarIndicators() {
  const items = channelList.querySelectorAll(".channel-item[data-channel-id]");
  items.forEach((item) => {
    const el = item as HTMLElement;
    const chId = el.dataset.channelId || "";
    let dot = el.querySelector(".channel-dot");
    const isStreaming = streamingChannels.has(chId);
    if (isStreaming) {
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "channel-dot streaming";
        el.appendChild(dot);
      } else {
        dot.className = "channel-dot streaming";
      }
    } else if (dot) {
      dot.remove();
    }
  });
}

// --- Channel header actions ---

function archiveCurrentChannel() {
  if (!currentChannel) return;
  const archived = currentChannel;
  fetch(`${getServer().url}/mux/channels/${archived.id}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => {});

  localChannels = localChannels.filter((c) => c.id !== archived.id);
  saveLocalChannels();
  localStorage.removeItem("lit-desktop-channel");
  currentChannel = null;
  channelTitle.textContent = "Welcome";
  channelActionsEl.innerHTML = "";
  clearMessages();
  if (channelWs) { channelWs.close(); channelWs = null; }
  refreshSidebar();
}

function renderChannelHeader() {
  if (!currentChannel) {
    channelActionsEl.innerHTML = "";
    return;
  }

  channelActionsEl.innerHTML = `<button class="kebab-btn header-btn" title="More">&#8942;</button>`;

  channelActionsEl.querySelector(".kebab-btn")?.addEventListener("click", (e) => {
    showContextMenu(e as MouseEvent, [
      { label: "Copy path", action: () => {
        if (currentChannel) navigator.clipboard.writeText(currentChannel.id).catch(() => {});
      }},
      { label: "Archive channel", action: archiveCurrentChannel },
    ]);
  });
}

// --- Channel ---

async function openChannel(channel: Channel) {
  currentChannel = channel;
  channelTitle.textContent = channel.name;
  localStorage.setItem("lit-desktop-channel", JSON.stringify({ id: channel.id, name: channel.name }));
  renderChannelHeader();
  clearMessages();

  if (channelWs) {
    channelWs.close();
    channelWs = null;
  }

  await loadChannelAgent(channel.id);

  try {
    const messages = await fetchChannelMessages(channel.id);

    if (messages.length === 0) {
      renderMessage({ role: "system", content: "No messages yet. Type something to start the conversation." });
    } else {
      for (const msg of messages) {
        knownMessageIds.add(msg.id);
        renderMessage({
          role: msg.direction === "in" ? "user" : "assistant",
          content: msg.content,
          id: msg.id,
          from: msg.from,
          timestamp: msg.timestamp,
          file_path: msg.file_path,
          metadata: msg.metadata,
        });
      }
    }

    await markChannelRead(channel.id);
    connectWebSocket(channel.id);
  } catch (err) {
    renderMessage({ role: "system", content: `Failed to load messages: ${err}` });
  }

  refreshSidebar();
  messageInput.focus();
}

// --- WebSocket ---

function connectWebSocket(channelId: string) {
  channelWs = createChannelWebSocket(channelId);

  channelWs.onopen = () => {
    wsReconnectAttempt = 0;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    showConnectionStatus("connected");
  };

  channelWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "new_messages" && Array.isArray(data.messages)) {
        let added = false;
        for (const msg of data.messages) {
          if (knownMessageIds.has(msg.id)) continue;
          knownMessageIds.add(msg.id);
          added = true;
          renderMessage({
            role: msg.direction === "in" ? "user" : "assistant",
            content: msg.content,
            id: msg.id,
            from: msg.from,
            timestamp: msg.timestamp,
            file_path: msg.file_path,
            metadata: msg.metadata,
          });
        }
        if (added && document.visibilityState === "visible") {
          markChannelRead(channelId).catch(() => {});
        }
      } else if (data.id && data.content && data.direction) {
        if (!knownMessageIds.has(data.id)) {
          knownMessageIds.add(data.id);
          renderMessage({
            role: data.direction === "in" ? "user" : "assistant",
            content: data.content,
            id: data.id,
            from: data.from,
            timestamp: data.timestamp,
            file_path: data.file_path,
            metadata: data.metadata,
          });
          if (streamingEl && data.direction === "in") {
            messagesEl.appendChild(streamingEl);
          }
          if (document.visibilityState === "visible") {
            markChannelRead(channelId).catch(() => {});
          }
        }
      } else if (data.type === "stream_start") {
        streamingChannels.add(channelId);
        activeStreamId = data.stream_id || null;
        renderSidebarIndicators();
        showTypingIndicator();
        cancelStreamBtn.style.display = "";
      } else if (data.type === "stream_chunk" && data.content) {
        appendStreamToken(data.content);
      } else if (data.type === "stream_end") {
        streamingChannels.delete(channelId);
        activeStreamId = null;
        renderSidebarIndicators();
        finalizeStream();
        cancelStreamBtn.style.display = "none";
      }
    } catch {
      // Non-JSON message, ignore
    }
  };

  channelWs.onerror = () => {};
  channelWs.onclose = () => {
    if (currentChannel?.id === channelId) {
      wsReconnect(channelId);
    }
  };
}

let wsReconnectAttempt = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsReconnect(channelId: string) {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(1.5, wsReconnectAttempt - 1), 15000);
  showConnectionStatus("reconnecting");
  wsReconnectTimer = setTimeout(() => {
    if (currentChannel?.id === channelId) {
      connectWebSocket(channelId);
    }
  }, delay);
}

function showConnectionStatus(status: "connected" | "reconnecting") {
  let indicator = document.getElementById("connection-status");
  if (status === "connected") {
    indicator?.remove();
    return;
  }
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "connection-status";
    document.getElementById("content-header")!.appendChild(indicator);
  }
  indicator.textContent = `Reconnecting...`;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentChannel) {
    markChannelRead(currentChannel.id).catch(() => {});
    if (channelWs?.readyState !== WebSocket.OPEN) {
      connectWebSocket(currentChannel.id);
    }
  }
});

// --- Streaming ---

let streamingEl: HTMLElement | null = null;
let streamingText = "";

function showTypingIndicator() {
  removeTypingIndicator();
  streamingText = "";
  const el = document.createElement("div");
  el.className = "message assistant streaming";
  const who = currentAgent?.name || "Agent";
  el.innerHTML = `<div class="message-header"><span class="message-author">${escapeHtml(who)}</span><span class="message-time">now</span></div><div class="message-content"><span class="typing-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>`;
  messagesEl.appendChild(el);
  if (!userIsScrolledUp) scrollToBottom();
  streamingEl = el;
}

function appendStreamToken(token: string) {
  if (!streamingEl) showTypingIndicator();
  streamingText += token;

  // During streaming, do a live parse and re-render parts
  const header = streamingEl!.querySelector(".message-header");
  streamingEl!.innerHTML = "";
  if (header) streamingEl!.appendChild(header);

  const parsed = parseMessageContent(streamingText);
  renderContentParts(streamingEl!, parsed.parts, "assistant");

  // If there are active tool groups, show "Working..." on the last one
  const toolGroups = streamingEl!.querySelectorAll(".tool-group");
  if (toolGroups.length > 0) {
    const lastGroup = toolGroups[toolGroups.length - 1];
    const label = lastGroup.querySelector(".tool-group-label");
    if (label && hasToolDelimiters(streamingText)) {
      const lastToolJson = streamingText.lastIndexOf("\x02TOOLJSON");
      const lastToolEnd = streamingText.lastIndexOf("\x03");
      const lastResultEnd = streamingText.lastIndexOf("[/TOOL_RESULT]");
      if (lastToolJson > lastResultEnd && lastToolJson > lastToolEnd) {
        label.textContent = "Working…";
        (label as HTMLElement).style.fontStyle = "italic";
      }
    }
  }

  if (!userIsScrolledUp) scrollToBottom();
}

function finalizeStream() {
  if (streamingEl && streamingText) {
    // Re-render with full parsing (tool calls become collapsible sections)
    const parsed = parseMessageContent(streamingText);
    const contentParent = streamingEl;

    // Remove old content and header, rebuild
    const header = contentParent.querySelector(".message-header");
    contentParent.innerHTML = "";
    if (header) contentParent.appendChild(header);

    renderContentParts(contentParent, parsed.parts, "assistant");

    if (parsed.links.length > 0) {
      const linksRow = document.createElement("div");
      linksRow.className = "links-row";
      for (const link of parsed.links) {
        const tag = document.createElement("span");
        tag.className = "link-tag";
        tag.textContent = `#${link.split("/").pop()}`;
        tag.title = link;
        linksRow.appendChild(tag);
      }
      contentParent.appendChild(linksRow);
    }

    streamingEl.classList.remove("streaming");
  }
  streamingEl = null;
  streamingText = "";
  removeTypingIndicator();
}

function removeTypingIndicator() {
  const dots = messagesEl.querySelector(".typing-dots");
  if (dots) {
    const msg = dots.closest(".message");
    if (msg && !streamingText) msg.remove();
  }
}

// --- Message actions ---

async function deleteMessage(channelId: string, messageId: string, el: HTMLElement) {
  try {
    await fetch(`${getServer().url}/mux/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
    el.remove();
    knownMessageIds.delete(messageId);
  } catch (err) {
    console.error("Failed to delete message:", err);
  }
}

// --- Image paste/upload ---

const MAX_PENDING_IMAGES = 3;
let pendingImageFiles: File[] = [];
let pendingImageDataUrls: string[] = [];

function renderPendingImages() {
  let row = document.getElementById("pending-images-row");
  if (pendingImageDataUrls.length === 0) {
    row?.remove();
    return;
  }
  if (!row) {
    row = document.createElement("div");
    row.id = "pending-images-row";
    const inputRow = document.getElementById("input-row")!;
    inputRow.parentElement!.insertBefore(row, inputRow);
  }
  row.innerHTML = "";
  for (let i = 0; i < pendingImageDataUrls.length; i++) {
    const wrap = document.createElement("div");
    wrap.className = "pending-image-preview";
    wrap.innerHTML = `<img src="${pendingImageDataUrls[i]}" /><button class="pending-image-remove" title="Remove">&times;</button>`;
    wrap.querySelector("button")!.addEventListener("click", () => {
      pendingImageFiles.splice(i, 1);
      pendingImageDataUrls.splice(i, 1);
      renderPendingImages();
    });
    row.appendChild(wrap);
  }
}

messageInput.addEventListener("paste", async (e) => {
  // Try legacy clipboardData.items first (works in Chromium-based webviews)
  const items = e.clipboardData?.items;
  let foundImage = false;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (pendingImageFiles.length >= MAX_PENDING_IMAGES) break;
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        foundImage = true;
        const file = item.getAsFile();
        if (!file) continue;
        pendingImageFiles.push(file);
        const reader = new FileReader();
        reader.onload = () => {
          pendingImageDataUrls.push(reader.result as string);
          renderPendingImages();
        };
        reader.readAsDataURL(file);
      }
    }
  }

  // Fallback: use Clipboard API (needed for WebKit2GTK / Tauri on Linux)
  if (!foundImage && navigator.clipboard?.read) {
    try {
      const clipItems = await navigator.clipboard.read();
      for (const clipItem of clipItems) {
        if (pendingImageFiles.length >= MAX_PENDING_IMAGES) break;
        const imageType = clipItem.types.find(t => t.startsWith("image/"));
        if (imageType) {
          e.preventDefault();
          const blob = await clipItem.getType(imageType);
          const file = new File([blob], `clipboard-${Date.now()}.png`, { type: imageType });
          pendingImageFiles.push(file);
          const reader = new FileReader();
          reader.onload = () => {
            pendingImageDataUrls.push(reader.result as string);
            renderPendingImages();
          };
          reader.readAsDataURL(file);
        }
      }
    } catch {
      // Clipboard read not available or denied
    }
  }
});

// --- Send ---

async function handleSend() {
  const text = messageInput.value.trim();
  if (!text && pendingImageFiles.length === 0) return;
  if (!currentChannel) return;

  messageInput.value = "";
  autoResize(messageInput);

  let content = text;

  // Upload pending images
  if (pendingImageFiles.length > 0) {
    const files = [...pendingImageFiles];
    pendingImageFiles = [];
    pendingImageDataUrls = [];
    renderPendingImages();

    const imageMarkdowns: string[] = [];
    const imageNames: string[] = [];
    for (const file of files) {
      try {
        const result = await uploadImage(file, currentChannel.id);
        imageMarkdowns.push(`![Pasted image](${result.url})`);
        imageNames.push(result.filename);
      } catch (err) {
        console.error("Failed to upload image:", err);
      }
    }
    if (imageMarkdowns.length > 0) {
      const imagesBlock = imageMarkdowns.join("\n\n");
      const namesNote = imageNames.map((n) => `(Image: ${n})`).join(" ");
      content = content
        ? `${imagesBlock}\n\n${content}\n\n${namesNote}`
        : `${imagesBlock}\n\nPlease look at ${imageNames.length > 1 ? "these images" : "this image"}: ${namesNote}`;
    }
  }

  renderMessage({ role: "user", content, timestamp: new Date().toISOString() });
  if (streamingEl) {
    messagesEl.appendChild(streamingEl);
  }

  try {
    await postChannelMessage(currentChannel.id, content);
  } catch (err) {
    renderMessage({ role: "system", content: `Failed to send: ${err}` });
  }
}

// --- Refresh ---

async function refreshSidebar() {
  try {
    const remote = await fetchChannels();
    channelListCache = remote;
    renderSidebar(mergeChannels(localChannels, remote));
  } catch {
    // Not critical
  }
}

async function refreshAgents() {
  try {
    agents = await fetchAgents();
    // Refresh throttle state for current agent
    if (currentAgent) {
      await loadAgentThrottle(currentAgent);
    }
    // Refresh usage for current agent's backend
    if (currentAgent) {
      try {
        usageReports[currentAgent.backend] = await fetchUsage(currentAgent.backend);
      } catch { /* non-critical */ }
    }
    renderAgentTabs();
    renderAgentInfo();
  } catch {
    // Not critical
  }
}

// --- Init ---

function initTheme() {
  const saved = localStorage.getItem("lit-theme")
    || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", saved);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.textContent = saved === "dark" ? "☾" : "☀";
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("lit-theme", next);
      btn.textContent = next === "dark" ? "☾" : "☀";
    });
  }
}

async function init() {
  initTheme();
  setStatus("connecting");
  initSidebar();

  const scrollBtn = document.getElementById("scroll-to-bottom");
  if (scrollBtn) scrollBtn.addEventListener("click", scrollToBottom);

  const connected = await checkConnection();
  if (!connected) {
    setStatus("disconnected");
    renderMessage({
      role: "system",
      content: "Cannot connect to LIT server at localhost:5000. Make sure the server is running.",
    });
    const retry = setInterval(async () => {
      setStatus("connecting");
      if (await checkConnection()) {
        clearInterval(retry);
        setStatus("connected");
        clearMessages();
        await loadInitialData();
      } else {
        setStatus("disconnected");
      }
    }, 5000);
    return;
  }

  setStatus("connected");
  await loadInitialData();
}

async function loadInitialData() {
  try {
    // Fetch agents, models, and channels in parallel
    const [agentsData, modelsData, remote] = await Promise.all([
      fetchAgents(),
      fetchModels().catch(() => ({})),
      fetchChannels(),
    ]);

    agents = agentsData;
    backendModels = modelsData;

    if (agents.length > 0) {
      const savedAgentId = localStorage.getItem("lit-desktop-agent");
      currentAgent = (savedAgentId && agents.find(a => a.id === savedAgentId)) || agents[0];
      // Load throttle state for all agents in parallel
      await Promise.all(agents.map((a) => loadAgentThrottle(a)));
      // Load usage for unique backends
      const backends = [...new Set(agents.map((a) => a.backend))];
      await Promise.all(
        backends.map(async (b) => {
          try {
            usageReports[b] = await fetchUsage(b);
          } catch {
            // Usage may not be available for all backends
          }
        })
      );
    }

    renderAgentTabs();
    renderAgentInfo();

    channelListCache = remote;
    const all = mergeChannels(localChannels, remote);
    renderSidebar(all);

    // Restore last active channel, or fall back to first
    let target = all[0] || null;
    try {
      const saved = JSON.parse(localStorage.getItem("lit-desktop-channel") || "");
      if (saved?.id) {
        const match = all.find((c) => c.id === saved.id);
        if (match) target = match;
      }
    } catch { /* no saved channel */ }

    if (target) {
      await openChannel(target);
    } else {
      clearMessages();
      renderMessage({ role: "system", content: "Open a project folder to get started. Click \"+ Open Folder\" in the sidebar." });
    }
  } catch (err) {
    renderMessage({ role: "system", content: `Failed to load data: ${err}` });
  }
}

// --- Command palette ---

interface Command {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  action: () => void;
}

function getCommands(): Command[] {
  const cmds: Command[] = [
    { id: "open-folder", label: "Open Folder", icon: "📂", action: handleOpenFolder },
    { id: "toggle-sidebar", label: "Toggle Sidebar", icon: "◧", shortcut: "Ctrl+\\", action: () => sidebarOpen ? collapseSidebar() : expandSidebar() },
    { id: "toggle-theme", label: "Toggle Theme", icon: "☾", action: () => document.getElementById("theme-toggle")?.click() },
    { id: "scroll-bottom", label: "Scroll to Bottom", icon: "↓", action: scrollToBottom },
  ];

  for (const ch of mergeChannels(localChannels, channelListCache)) {
    cmds.push({ id: `ch-${ch.id}`, label: `Switch to #${ch.name}`, icon: "#", action: () => openChannel(ch) });
  }

  for (const agent of agents) {
    cmds.push({ id: `agent-${agent.id}`, label: `Select agent: ${agent.name}`, icon: "🤖", action: () => selectAgent(agent) });
  }

  return cmds;
}

let channelListCache: Channel[] = [];
let commandPaletteSelectedIndex = 0;

function openCommandPalette() {
  const overlay = document.getElementById("command-palette-overlay")!;
  const input = document.getElementById("command-input") as HTMLInputElement;
  const list = document.getElementById("command-list")!;

  overlay.classList.add("visible");
  input.value = "";
  commandPaletteSelectedIndex = 0;
  renderCommandList(getCommands(), list);
  input.focus();
}

function closeCommandPalette() {
  document.getElementById("command-palette-overlay")!.classList.remove("visible");
}

function renderCommandList(cmds: Command[], list: HTMLElement) {
  list.innerHTML = "";
  cmds.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "command-item" + (i === commandPaletteSelectedIndex ? " selected" : "");
    item.innerHTML = `<span class="cmd-icon">${cmd.icon}</span><span>${escapeHtml(cmd.label)}</span>${cmd.shortcut ? `<span class="cmd-shortcut">${cmd.shortcut}</span>` : ""}`;
    item.addEventListener("click", () => { closeCommandPalette(); cmd.action(); });
    item.addEventListener("mouseenter", () => {
      commandPaletteSelectedIndex = i;
      list.querySelectorAll(".command-item").forEach((el, j) => el.classList.toggle("selected", j === i));
    });
    list.appendChild(item);
  });
}

function filterCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return getCommands().filter((c) => c.label.toLowerCase().includes(q));
}

// Command palette event wiring
document.getElementById("command-palette-overlay")!.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeCommandPalette();
});

document.getElementById("command-input")!.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  const list = document.getElementById("command-list")!;
  commandPaletteSelectedIndex = 0;
  renderCommandList(filterCommands(input.value), list);
});

document.getElementById("command-input")!.addEventListener("keydown", (e) => {
  const list = document.getElementById("command-list")!;
  const items = list.querySelectorAll(".command-item");

  if (e.key === "Escape") {
    closeCommandPalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    commandPaletteSelectedIndex = Math.min(commandPaletteSelectedIndex + 1, items.length - 1);
    items.forEach((el, j) => el.classList.toggle("selected", j === commandPaletteSelectedIndex));
    items[commandPaletteSelectedIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    commandPaletteSelectedIndex = Math.max(commandPaletteSelectedIndex - 1, 0);
    items.forEach((el, j) => el.classList.toggle("selected", j === commandPaletteSelectedIndex));
    items[commandPaletteSelectedIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = items[commandPaletteSelectedIndex] as HTMLElement;
    if (selected) selected.click();
  }
});

// --- Event listeners ---

messageInput.addEventListener("input", () => autoResize(messageInput));
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});
sendBtn.addEventListener("click", handleSend);

cancelStreamBtn.addEventListener("click", async () => {
  if (activeStreamId) {
    try {
      await cancelStream(activeStreamId);
    } catch { /* non-critical */ }
    activeStreamId = null;
    cancelStreamBtn.style.display = "none";
    finalizeStream();
    if (currentChannel) {
      streamingChannels.delete(currentChannel.id);
      renderSidebarIndicators();
    }
  }
});

// Input area resize
let inputAreaHeight = parseInt(localStorage.getItem("lit-input-height") || "0");
if (inputAreaHeight > 0) {
  inputArea.style.height = inputAreaHeight + "px";
}

inputResizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = inputArea.offsetHeight;

  const onMove = (ev: MouseEvent) => {
    const newH = Math.max(80, Math.min(500, startH - (ev.clientY - startY)));
    inputArea.style.height = newH + "px";
    inputAreaHeight = newH;
  };

  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    localStorage.setItem("lit-input-height", String(inputAreaHeight));
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    openCommandPalette();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    sidebarOpen ? collapseSidebar() : expandSidebar();
  }
});

// --- Image lightbox ---

const lightboxEl = document.getElementById("image-lightbox")!;
const lightboxImg = document.getElementById("lightbox-img") as HTMLImageElement;

let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let lightboxDragging = false;
let lightboxDragStartX = 0;
let lightboxDragStartY = 0;

function updateLightboxTransform() {
  lightboxImg.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
}

function closeLightbox() {
  lightboxEl.classList.remove("active");
  lightboxImg.src = "";
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  lightboxImg.style.transform = "";
}

messagesEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "IMG" && target.closest(".message-content")) {
    lightboxImg.src = (target as HTMLImageElement).src;
    lightboxZoom = 1;
    lightboxPanX = 0;
    lightboxPanY = 0;
    lightboxImg.style.transform = "";
    lightboxEl.classList.add("active");
  }
});

lightboxEl.addEventListener("click", (e) => {
  if (!lightboxDragging && (e.target as HTMLElement).tagName !== "IMG") {
    closeLightbox();
  }
});

lightboxImg.addEventListener("mousedown", (e) => {
  e.preventDefault();
  lightboxDragging = true;
  lightboxDragStartX = e.clientX - lightboxPanX;
  lightboxDragStartY = e.clientY - lightboxPanY;
  lightboxImg.style.cursor = "grabbing";
  lightboxImg.style.transition = "none";
});

document.addEventListener("mousemove", (e) => {
  if (!lightboxDragging) return;
  lightboxPanX = e.clientX - lightboxDragStartX;
  lightboxPanY = e.clientY - lightboxDragStartY;
  updateLightboxTransform();
});

document.addEventListener("mouseup", () => {
  if (lightboxDragging) {
    lightboxDragging = false;
    lightboxImg.style.cursor = "";
    lightboxImg.style.transition = "";
  }
});

lightboxEl.addEventListener("wheel", (e) => {
  if (!lightboxEl.classList.contains("active")) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  lightboxZoom = Math.max(0.2, Math.min(10, lightboxZoom + delta));
  updateLightboxTransform();
}, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && lightboxEl.classList.contains("active")) {
    closeLightbox();
  }
});

setInterval(refreshSidebar, 15000);
setInterval(refreshAgents, 30000);

init();
