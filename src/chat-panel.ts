// ChatPanel — the componentized chat view (stage 2b-i of the refactor).
//
// Everything that used to live as module-level globals in main.ts (channel
// sidebar, messages area, streaming render, agent tabs/controls, send/upload,
// WS lifecycle) now lives on this class. One instance exists today (main.ts's
// `chatPanel`, constructed with the app-active scope); the class boundary is
// what a future multi-instance UI builds on. The DOM comes from the
// <template id="chat-panel-template"> in index.html — mount() clones it into
// the dockview panel host, and every element lookup is per-instance
// (root.querySelector on classes, never document.getElementById).

import {
  hostFetch,
  fetchAgents,
  fetchChannels,
  fetchChannelMessages,
  fetchMessagesAround,
  postChannelMessage,
  createChannelWebSocket,
  markChannelRead,
  openFolder,
  setChannelAgent,
  getChannelConfig,
  getChannelModelOverride,
  setChannelModelOverride,
  fetchModels,
  updateAgent,
  setHeartbeatEnabled,
  setSafeMode,
  getSafeMode,
  setInterrupt,
  clearInterrupt,
  getInterrupt,
  fetchUsage,
  fetchBackendStatus,
  cancelStream,
  uploadImage,
  authHeaders,
  type Scope,
  type Agent,
  type Channel,
  type BackendModel,
  type UsageReport,
  type ThrottleState,
} from "./api";
import { open } from "@tauri-apps/plugin-dialog";
import { renderMarkdown } from "./markdown";
import { openSettings } from "./settings";
import { openTerminal, isTerminalOpen, fitToGrid } from "./terminal";
import { brand } from "./brand";

// --- Shared helpers (module-level: no per-instance state) ---

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

function mergeChannels(local: Channel[], remote: Channel[]): Channel[] {
  const map = new Map<string, Channel>();
  for (const ch of local) map.set(ch.id, ch);
  for (const ch of remote) map.set(ch.id, ch);
  return Array.from(map.values());
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

  // Normalize STX/ETX tool-result delimiters (\x02RESULT\x03 … \x02/RESULT\x03)
  // to the bracket form the tool-parser walks below. Without this the result
  // leaks as raw text AND its tool call never resolves (spinner spins forever).
  content = content
    .replace(/\x02RESULT\x03/g, "[TOOL_RESULT]")
    .replace(/\x02\/RESULT\x03/g, "[/TOOL_RESULT]");

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
      linkifyFilePaths(paramEl);
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
    linkifyFilePaths(resultContent, { includePre: true });
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

// Absolute unix paths (or ~/paths) with a file extension become clickable
// buttons that open the file in the viewer panel — same behavior as the
// webapp's markdown-extensions directive, same regex. Buttons carry the path
// in data-path; the click is handled by ChatPanel's delegated listener so the
// open routes through the panel's own scope (local vs remote server).
const FILE_PATH_REGEX = /(?<![:/\w])((?:\/[\w.@+-]+)+\.\w+|~(?:\/[\w.@+-]+)+\.\w+)/g;

export function linkifyFilePaths(container: HTMLElement, opts?: { includePre?: boolean }): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".md-path-btn") || parent.closest("a")) {
        return NodeFilter.FILTER_REJECT;
      }
      // Markdown code fences stay plain; tool results opt in via includePre.
      if (!opts?.includePre && parent.closest("pre")) {
        return NodeFilter.FILTER_REJECT;
      }
      FILE_PATH_REGEX.lastIndex = 0;
      return FILE_PATH_REGEX.test(node.textContent || "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  for (const textNode of textNodes) {
    const text = textNode.textContent || "";
    const parent = textNode.parentElement;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    FILE_PATH_REGEX.lastIndex = 0;
    while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
      if (match.index > lastEnd) frag.appendChild(document.createTextNode(text.slice(lastEnd, match.index)));
      const btn = document.createElement("button");
      btn.className = "md-path-btn";
      btn.textContent = match[1];
      btn.dataset.path = match[1];
      btn.title = "Open file";
      frag.appendChild(btn);
      lastEnd = match.index + match[0].length;
    }
    if (lastEnd === 0) continue;
    if (lastEnd < text.length) frag.appendChild(document.createTextNode(text.slice(lastEnd)));

    // Replace a wrapping <code> entirely so the button isn't styled as code.
    if (parent.tagName === "CODE" && parent.parentElement) {
      parent.parentElement.replaceChild(frag, parent);
    } else {
      parent.replaceChild(frag, textNode);
    }
  }
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
      linkifyFilePaths(content);
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

// --- Agent control constants ---

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

// --- The component ---

export class ChatPanel {
  /** The (server, team) this view stands in. Every API call threads it. */
  readonly scope: Scope;

  // --- Cross-panel touch points main.ts wires up ---
  /** Search button in the channel header was clicked. */
  onOpenSearch: (() => void) | null = null;
  /** Terminal toggle button in the channel header was clicked. */
  onToggleTerminal: (() => void) | null = null;
  /** "Reload everything" (settings closed, onboarding CTA) — main.ts's loadInitialData. */
  onReload: (() => void) | null = null;
  /** An image inside a message was clicked (main.ts opens the lightbox). */
  onImageClick: ((src: string) => void) | null = null;
  onOpenFile: ((path: string) => void) | null = null;

  // --- Chat state (former main.ts module globals) ---
  currentChannel: Channel | null = null;
  currentAgent: Agent | null = null;
  // Per-(channel, currentAgent) model override — null means "follow the agent's default".
  // Reloaded whenever the open channel or its bound agent changes.
  private channelModelOverride: string | null = null;
  agents: Agent[] = [];
  private channelWs: WebSocket | null = null;
  private knownMessageIds = new Set<string>();
  private localChannels: Channel[] = [];
  private channelListCache: Channel[] = [];
  private userIsScrolledUp = false;
  private streamingChannels = new Set<string>();
  private activeStreamId: string | null = null;

  // Agent control state
  private backendModels: Record<string, BackendModel[]> = {};
  private agentThrottles: Record<string, ThrottleState> = {};
  private usageReports: Record<string, UsageReport> = {};

  // Sidebar state
  // Per-place prefs — loaded in the constructor once scope exists.
  private sidebarWidth = 240;
  private sidebarOpen = true;

  // WS reconnect state
  private wsReconnectAttempt = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Streaming render state
  private streamingEl: HTMLElement | null = null;
  private streamingText = "";
  // Timestamp of the last stream_end that carried content — used to suppress the
  // duplicate persisted assistant message that arrives just after (webapp parity).
  private lastStreamEndTime = 0;

  // Pending pasted images
  private pendingImageFiles: File[] = [];
  private pendingImageDataUrls: string[] = [];

  // Header favorites (promoted message-header items)
  private headerFavorites = loadHeaderFavorites();
  private headerItemOrder = loadHeaderOrder();
  // Store msg data per element so we can re-render headers after pref changes
  private msgDataMap = new WeakMap<HTMLElement, { msg: RenderableMessage; parsed: ParsedContent }>();

  // Input area resize state
  private inputAreaHeight = parseInt(localStorage.getItem("lit-input-height") || "0");

  // Refresh intervals (started on mount, stopped on dispose)
  private sidebarRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private agentsRefreshInterval: ReturnType<typeof setInterval> | null = null;

  private disposed = false;

  // --- DOM (cloned from #chat-panel-template on mount) ---
  private root: HTMLElement | null = null;
  private messageInput!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private messagesEl!: HTMLDivElement;
  private channelList!: HTMLDivElement;
  private channelTitle!: HTMLHeadingElement;
  private channelActionsEl!: HTMLDivElement;
  private agentTabsEl!: HTMLDivElement;
  private agentInfoEl!: HTMLDivElement;
  private sidebarEl!: HTMLElement;
  private sidebarResizeHandle!: HTMLDivElement;
  private sidebarExpandBtn!: HTMLButtonElement;
  private cancelStreamBtn!: HTMLButtonElement;
  private inputResizeHandle!: HTMLDivElement;
  private inputArea!: HTMLDivElement;
  private scrollBtn!: HTMLElement;
  private contentHeader!: HTMLElement;
  private inputRow!: HTMLDivElement;
  private terminalToggleBtn!: HTMLButtonElement;

  private readonly visibilityHandler = () => {
    if (document.visibilityState === "visible" && this.currentChannel) {
      markChannelRead(this.currentChannel.id, this.scope).catch(() => {});
      if (this.channelWs?.readyState !== WebSocket.OPEN) {
        this.connectWebSocket(this.currentChannel.id);
      }
    }
  };

  constructor(scope: Scope) {
    this.scope = scope;
    this.localChannels = this.loadLocalChannels();
    // Nav width/visibility are per-place layout prefs (a jovai tab and a local
    // tab can differ); legacy unscoped values seed the local place.
    const width = localStorage.getItem(this.scopedKey("lit-sidebar-width"))
      ?? (this.scope.connection.id === "local" ? localStorage.getItem("lit-sidebar-width") : null);
    this.sidebarWidth = parseInt(width || "240");
    const openPref = localStorage.getItem(this.scopedKey("lit-sidebar-open"))
      ?? (this.scope.connection.id === "local" ? localStorage.getItem("lit-sidebar-open") : null);
    this.sidebarOpen = openPref !== "false";
  }

  /** Per-place localStorage key — each (server, team) keeps its own channel
   *  memory, so a remote tab can never prune another place's channels. */
  private scopedKey(base: string): string {
    return `${base}:${this.scope.connection.id}:${this.scope.team}`;
  }

  private loadLocalChannels(): Channel[] {
    try {
      const raw = localStorage.getItem(this.scopedKey("lit-desktop-channels"))
        // Legacy unscoped key — pre-multi-tab data, local connection only.
        ?? (this.scope.connection.id === "local" ? localStorage.getItem("lit-desktop-channels") : null);
      return JSON.parse(raw || "[]");
    } catch { return []; }
  }

  // --- Lifecycle ---

  mount(host: HTMLElement): void {
    if (!this.root) {
      const tpl = document.getElementById("chat-panel-template") as HTMLTemplateElement;
      const frag = tpl.content.cloneNode(true) as DocumentFragment;
      this.root = frag.firstElementChild as HTMLElement;
      this.grabElements();
      this.wireEvents();
      this.initSidebar();
    }
    host.appendChild(this.root);
    if (!this.sidebarRefreshInterval) {
      this.sidebarRefreshInterval = setInterval(() => this.refreshSidebar(), 15000);
    }
    if (!this.agentsRefreshInterval) {
      this.agentsRefreshInterval = setInterval(() => this.refreshAgents(), 30000);
    }
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  dispose(): void {
    this.disposed = true;
    if (this.channelWs) { this.channelWs.close(); this.channelWs = null; }
    if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    if (this.sidebarRefreshInterval) { clearInterval(this.sidebarRefreshInterval); this.sidebarRefreshInterval = null; }
    if (this.agentsRefreshInterval) { clearInterval(this.agentsRefreshInterval); this.agentsRefreshInterval = null; }
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.root?.remove();
    this.root = null;
  }

  private grabElements(): void {
    const root = this.root!;
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.messageInput = q<HTMLTextAreaElement>(".message-input");
    this.sendBtn = q<HTMLButtonElement>(".send-btn");
    this.messagesEl = q<HTMLDivElement>(".messages");
    this.channelList = q<HTMLDivElement>(".channel-list");
    this.channelTitle = q<HTMLHeadingElement>(".channel-title");
    this.channelActionsEl = q<HTMLDivElement>(".channel-actions");
    this.agentTabsEl = q<HTMLDivElement>(".agent-tabs");
    this.agentInfoEl = q<HTMLDivElement>(".agent-info");
    this.sidebarEl = q<HTMLElement>(".sidebar");
    this.sidebarResizeHandle = q<HTMLDivElement>(".sidebar-resize-handle");
    this.sidebarExpandBtn = q<HTMLButtonElement>(".sidebar-expand-btn");
    this.cancelStreamBtn = q<HTMLButtonElement>(".cancel-stream-btn");
    this.inputResizeHandle = q<HTMLDivElement>(".input-resize-handle");
    this.inputArea = q<HTMLDivElement>(".input-area");
    this.scrollBtn = q<HTMLElement>(".scroll-to-bottom");
    this.contentHeader = q<HTMLElement>(".content-header");
    this.inputRow = q<HTMLDivElement>(".input-row");
    this.terminalToggleBtn = q<HTMLButtonElement>(".terminal-toggle-btn");
  }

  private wireEvents(): void {
    this.messagesEl.addEventListener("scroll", () => {
      this.userIsScrolledUp = !this.isNearBottom();
      this.updateScrollButton();
    });

    this.scrollBtn.addEventListener("click", () => this.scrollToBottom());

    // Header buttons whose behavior lives outside the panel (search dock panel,
    // terminal overlay) — main.ts provides the handlers.
    (this.root!.querySelector(".search-toggle-btn") as HTMLElement)
      .addEventListener("click", () => this.onOpenSearch?.());
    this.terminalToggleBtn.addEventListener("click", () => this.onToggleTerminal?.());

    // With the nav hidden, the channel title doubles as the channel selector.
    this.channelTitle.addEventListener("click", (e) => {
      if (!this.sidebarOpen) this.showChannelTitleMenu(e);
    });

    // Image lightbox trigger — the lightbox itself stays app-level in main.ts.
    this.messagesEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "IMG" && target.closest(".message-content")) {
        this.onImageClick?.((target as HTMLImageElement).src);
      }
      const pathBtn = target.closest(".md-path-btn") as HTMLElement | null;
      if (pathBtn?.dataset.path) {
        e.preventDefault();
        this.onOpenFile?.(pathBtn.dataset.path);
      }
    });

    // Send
    this.messageInput.addEventListener("input", () => autoResize(this.messageInput));
    this.messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.sendBtn.addEventListener("click", () => this.handleSend());

    this.cancelStreamBtn.addEventListener("click", async () => {
      if (this.activeStreamId) {
        try {
          await cancelStream(this.activeStreamId, this.scope);
        } catch { /* non-critical */ }
        this.activeStreamId = null;
        this.cancelStreamBtn.style.display = "none";
        this.finalizeStream();
        if (this.currentChannel) {
          this.streamingChannels.delete(this.currentChannel.id);
          this.renderSidebarIndicators();
        }
      }
    });

    // Image paste
    this.messageInput.addEventListener("paste", (e) => this.handlePaste(e));

    // Input area resize
    if (this.inputAreaHeight > 0) {
      this.inputArea.style.height = this.inputAreaHeight + "px";
    }
    this.inputResizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.inputArea.offsetHeight;

      const onMove = (ev: MouseEvent) => {
        const newH = Math.max(80, Math.min(500, startH - (ev.clientY - startY)));
        this.inputArea.style.height = newH + "px";
        this.inputAreaHeight = newH;
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        localStorage.setItem("lit-input-height", String(this.inputAreaHeight));
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // --- Sidebar ---

  private initSidebar(): void {
    this.sidebarEl.style.width = this.sidebarWidth + "px";
    this.sidebarEl.style.minWidth = this.sidebarWidth + "px";
    if (!this.sidebarOpen) this.collapseSidebar();

    this.sidebarExpandBtn.addEventListener("click", () => this.expandSidebar());

    // Resize drag
    this.sidebarResizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        const newW = Math.max(160, Math.min(400, startW + ev.clientX - startX));
        this.sidebarWidth = newW;
        this.sidebarEl.style.width = newW + "px";
        this.sidebarEl.style.minWidth = newW + "px";
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        localStorage.setItem(this.scopedKey("lit-sidebar-width"), String(this.sidebarWidth));
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  private collapseSidebar(): void {
    this.sidebarOpen = false;
    this.sidebarEl.classList.add("collapsed");
    this.sidebarResizeHandle.style.display = "none";
    this.sidebarExpandBtn.style.display = "";
    // Webapp parity: with the nav hidden, the channel title becomes the
    // channel selector (dropdown), so switching never requires re-showing it.
    this.channelTitle.classList.add("channel-title-menu");
    localStorage.setItem(this.scopedKey("lit-sidebar-open"), "false");
  }

  private expandSidebar(): void {
    this.sidebarOpen = true;
    this.sidebarEl.classList.remove("collapsed");
    this.sidebarResizeHandle.style.display = "";
    this.sidebarExpandBtn.style.display = "none";
    this.channelTitle.classList.remove("channel-title-menu");
    localStorage.setItem(this.scopedKey("lit-sidebar-open"), "true");
  }

  /** Channel dropdown on the title while the nav is hidden (webapp parity). */
  private showChannelTitleMenu(e: MouseEvent): void {
    const items: MenuItem[] = this.getChannels().map((ch) => ({
      label: `${this.currentChannel?.id === ch.id ? "✓ " : "  "}# ${ch.name}`,
      action: () => { void this.openChannel(ch); },
    }));
    items.push({ label: "", action: () => {}, type: "separator" });
    items.push({ label: "Open Folder…", action: () => this.handleOpenFolder() });
    items.push({ label: "Show navigation", action: () => this.expandSidebar() });
    showContextMenu(e, items);
  }

  toggleSidebar(): void {
    this.sidebarOpen ? this.collapseSidebar() : this.expandSidebar();
  }

  /** Merged local + server channel list (used by the command palette). */
  getChannels(): Channel[] {
    return mergeChannels(this.localChannels, this.channelListCache);
  }

  /** Active-state for the terminal toggle button in this panel's header. */
  setTerminalButtonActive(active: boolean): void {
    this.terminalToggleBtn?.classList.toggle("active", active);
  }

  private saveLocalChannels(): void {
    localStorage.setItem(this.scopedKey("lit-desktop-channels"), JSON.stringify(this.localChannels));
  }

  // --- Scroll management ---

  private isNearBottom(): boolean {
    const threshold = 80;
    return this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < threshold;
  }

  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    this.userIsScrolledUp = false;
    this.updateScrollButton();
  }

  private updateScrollButton(): void {
    if (!this.scrollBtn) return;
    if (this.userIsScrolledUp) {
      this.scrollBtn.classList.add("visible");
    } else {
      this.scrollBtn.classList.remove("visible");
    }
  }

  // --- Jump / history ---

  /** Jump to a message. If it's already loaded, scroll + flash. If it's back in
   *  history, load a window centered on it (seekable timeline), re-render, then
   *  snap to it — same model as the webapp. */
  async jumpToMessage(id?: string): Promise<void> {
    if (!id || !this.currentChannel) return;
    const sel = `[data-message-id="${CSS.escape(id)}"]`;
    let el = this.messagesEl.querySelector(sel) as HTMLElement | null;

    if (!el) {
      try {
        const { messages, hasNewer } = await fetchMessagesAround(this.currentChannel.id, id, 50, this.scope);
        if (messages.length) {
          this.clearMessages();
          if (hasNewer) this.renderHistoryBanner(this.currentChannel);
          for (const msg of messages) {
            this.knownMessageIds.add(msg.id);
            this.renderMessage({
              role: msg.direction === "in" ? "user" : "assistant",
              content: msg.content,
              id: msg.id,
              from: msg.from,
              timestamp: msg.timestamp,
              file_path: msg.file_path,
              metadata: msg.metadata,
            });
          }
          el = this.messagesEl.querySelector(sel);
        }
      } catch {
        /* leave the current view as-is on failure */
      }
    }

    if (el) {
      const target = el;
      // instant, not smooth — the list was fully replaced, so animating is disorienting
      target.scrollIntoView({ behavior: "auto", block: "center" });
      target.classList.add("message-flash");
      setTimeout(() => target.classList.remove("message-flash"), 1600);
    }
  }

  /** Banner shown atop the message list when it's showing history (not the live
   *  tail). Clicking returns to the latest messages. */
  private renderHistoryBanner(channel: Channel): void {
    const banner = document.createElement("div");
    banner.className = "history-banner";
    banner.innerHTML =
      `<span>Viewing history</span>` +
      `<button class="history-latest-btn" type="button">Jump to latest &#8595;</button>`;
    banner.querySelector(".history-latest-btn")!.addEventListener("click", () => this.openChannel(channel));
    this.messagesEl.appendChild(banner);
  }

  // --- Header favorites ---

  private saveHeaderPrefs(): void {
    localStorage.setItem("lit-desktop-header-favs", JSON.stringify([...this.headerFavorites]));
    localStorage.setItem("lit-desktop-header-order", JSON.stringify(this.headerItemOrder));
  }

  private executeItemAction(id: string, msg: RenderableMessage, el: HTMLElement, parsed: ParsedContent): void {
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
        if (this.currentChannel && msg.id) this.deleteMessage(this.currentChannel.id, msg.id, el);
        break;
    }
  }

  private renderHeaderFavorites(header: HTMLElement, msg: RenderableMessage, el: HTMLElement, parsed: ParsedContent): void {
    // Remove existing favorites and kebab (keep author + spacer)
    header.querySelectorAll(".header-fav, .kebab-btn").forEach((n) => n.remove());

    const kebabBtn = document.createElement("button");
    kebabBtn.className = "kebab-btn";
    kebabBtn.title = "More";
    kebabBtn.innerHTML = "&#8942;";
    kebabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showHeaderMenu(e as MouseEvent, msg, el, parsed);
    });

    for (const itemId of this.headerItemOrder) {
      if (!this.headerFavorites.has(itemId) || !isItemVisible(itemId, msg)) continue;
      const badge = document.createElement("span");
      badge.className = `header-fav fav-${itemId}`;
      badge.innerHTML = getItemBadgeHtml(itemId, msg);
      badge.title = HEADER_ITEM_LABELS[itemId] || itemId;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        this.executeItemAction(itemId, msg, el, parsed);
      });
      header.insertBefore(badge, null);
    }

    header.appendChild(kebabBtn);
  }

  private refreshAllHeaders(): void {
    this.messagesEl.querySelectorAll(".message").forEach((msgEl) => {
      const data = this.msgDataMap.get(msgEl as HTMLElement);
      if (!data) return;
      const header = msgEl.querySelector(".message-header") as HTMLElement;
      if (header) this.renderHeaderFavorites(header, data.msg, msgEl as HTMLElement, data.parsed);
    });
  }

  private showHeaderMenu(event: MouseEvent, msg: RenderableMessage, msgEl: HTMLElement, parsed: ParsedContent): void {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu header-menu";

    for (let i = 0; i < this.headerItemOrder.length; i++) {
      const itemId = this.headerItemOrder[i];
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
        const idx = this.headerItemOrder.indexOf(itemId);
        if (idx > 0) {
          [this.headerItemOrder[idx], this.headerItemOrder[idx - 1]] = [this.headerItemOrder[idx - 1], this.headerItemOrder[idx]];
          this.saveHeaderPrefs();
          this.refreshAllHeaders();
          this.showHeaderMenu(event, msg, msgEl, parsed);
        }
      });
      controls.appendChild(upBtn);

      // Reorder down
      const downBtn = document.createElement("span");
      downBtn.className = `reorder-arrow${i === this.headerItemOrder.length - 1 ? " disabled" : ""}`;
      downBtn.textContent = "▼";
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = this.headerItemOrder.indexOf(itemId);
        if (idx < this.headerItemOrder.length - 1) {
          [this.headerItemOrder[idx], this.headerItemOrder[idx + 1]] = [this.headerItemOrder[idx + 1], this.headerItemOrder[idx]];
          this.saveHeaderPrefs();
          this.refreshAllHeaders();
          this.showHeaderMenu(event, msg, msgEl, parsed);
        }
      });
      controls.appendChild(downBtn);

      // Star toggle
      const star = document.createElement("span");
      star.className = "fav-star";
      star.textContent = this.headerFavorites.has(itemId) ? "★" : "☆";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.headerFavorites.has(itemId)) {
          this.headerFavorites.delete(itemId);
        } else {
          this.headerFavorites.add(itemId);
        }
        this.saveHeaderPrefs();
        this.refreshAllHeaders();
        this.showHeaderMenu(event, msg, msgEl, parsed);
      });
      controls.appendChild(star);

      row.appendChild(controls);

      // Click the row to execute the action
      row.addEventListener("click", () => {
        closeContextMenu();
        this.executeItemAction(itemId, msg, msgEl, parsed);
      });

      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    const menuWidth = 280;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth);
    const y = Math.min(event.clientY, window.innerHeight - this.headerItemOrder.length * 36 - 8);
    menu.style.left = x + "px";
    menu.style.top = y + "px";

    setTimeout(() => {
      document.addEventListener("click", closeContextMenu, { once: true });
    }, 0);
  }

  // --- Message rendering ---

  renderMessage(msg: RenderableMessage): HTMLElement | null {
    if (!this.root) return null; // not mounted (never the case in practice)
    const parsed = parseMessageContent(msg.content);
    if (!hasVisibleContent(parsed)) return null;

    const el = document.createElement("div");
    el.className = `message ${msg.role}`;
    if (msg.id) el.dataset.messageId = msg.id;

    // Header
    const header = document.createElement("div");
    header.className = "message-header";
    const who = msg.role === "user" ? "You" : (msg.from || this.currentAgent?.name || "Agent");

    const authorSpan = document.createElement("span");
    authorSpan.className = "message-author";
    authorSpan.textContent = who;
    header.appendChild(authorSpan);

    const spacer = document.createElement("span");
    spacer.className = "header-spacer";
    header.appendChild(spacer);

    // Render promoted favorites + kebab, and store data for live refresh
    if (msg.role !== "system" && msg.id) {
      this.msgDataMap.set(el, { msg, parsed });
      this.renderHeaderFavorites(header, msg, el, parsed);
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

    this.messagesEl.appendChild(el);

    if (!this.userIsScrolledUp) {
      this.scrollToBottom();
    } else {
      this.updateScrollButton();
    }

    return el;
  }

  clearMessages(): void {
    if (!this.root) return; // not mounted (never the case in practice)
    this.messagesEl.innerHTML = "";
    this.knownMessageIds.clear();
    this.userIsScrolledUp = false;
    this.updateScrollButton();
  }

  private renderOnboarding(): void {
    this.clearMessages();
    const wrap = document.createElement("div");
    wrap.className = "message system";
    const content = document.createElement("div");
    content.className = "message-content";
    const logoHtml = brand.logo ? `<img src="${brand.logo}" alt="${brand.displayName}" class="brand-logo" />` : "";
    content.innerHTML =
      logoHtml +
      `<p><strong>Welcome to ${brand.displayName}.</strong></p>` +
      "<p>To get started, add a connection (your Claude subscription or an API key) and create an agent.</p>";
    const btn = document.createElement("button");
    btn.className = "settings-primary-btn";
    btn.textContent = "Set up a connection & agent";
    btn.addEventListener("click", () => openSettings(() => this.onReload?.()));
    content.appendChild(btn);
    wrap.appendChild(content);
    this.messagesEl.appendChild(wrap);
  }

  // --- Agent tabs ---

  private getPresenceClass(agent: Agent): string {
    const throttle = this.agentThrottles[agent.id];
    if (throttle === "disabled") return "offline";
    if (throttle === "stopped") return "stopped";
    if (agent.status === "busy") return "busy";
    return "idle";
  }

  private renderAgentTabs(): void {
    this.agentTabsEl.innerHTML = "";

    for (const agent of this.agents) {
      const tab = document.createElement("div");
      tab.className = "agent-tab";
      if (this.currentAgent?.id === agent.id) tab.classList.add("active");

      const presenceClass = this.getPresenceClass(agent);
      tab.innerHTML = `<span class="status-indicator ${presenceClass}"></span><span>${escapeHtml(agent.name)}</span>`;

      tab.addEventListener("click", () => this.selectAgent(agent));
      this.agentTabsEl.appendChild(tab);
    }

    const addBtn = document.createElement("div");
    addBtn.className = "agent-tab-add";
    addBtn.textContent = "+";
    addBtn.title = "Add agent";
    addBtn.addEventListener("click", () => openSettings(() => this.onReload?.(), { tab: "agents", agentId: "new" }));
    this.agentTabsEl.appendChild(addBtn);
  }

  private renderAgentInfo(): void {
    if (!this.currentAgent) {
      this.agentInfoEl.innerHTML = "";
      return;
    }

    const agent = this.currentAgent;
    const throttle = this.agentThrottles[agent.id] || "disabled";
    const models = this.backendModels[agent.backend] || [];
    const usage = this.usageReports[agent.backend];

    this.agentInfoEl.innerHTML = "";

    // Throttle icon button
    const throttleBtn = document.createElement("button");
    throttleBtn.className = `agent-ctrl-btn throttle-btn throttle-${throttle}`;
    throttleBtn.title = THROTTLE_LABEL[throttle];
    throttleBtn.innerHTML = THROTTLE_SVG[throttle];
    throttleBtn.style.color = THROTTLE_COLOR[throttle];
    throttleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showThrottleMenu(e, agent, throttle);
    });
    this.agentInfoEl.appendChild(throttleBtn);

    // Settings icon button
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "agent-ctrl-btn settings-btn";
    settingsBtn.title = "Agent settings";
    settingsBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`;
    settingsBtn.addEventListener("click", () => openSettings(() => this.onReload?.(), { tab: "agents", agentId: agent.id }));
    this.agentInfoEl.appendChild(settingsBtn);

    // Model selector button (flat text + chevron, opens dropdown)
    // In a channel, a per-channel override (if set) takes effect instead of the agent default.
    const effectiveModel = (this.currentChannel && this.channelModelOverride) || agent.model;
    const modelBtn = document.createElement("button");
    modelBtn.className = "agent-model-btn";
    const displayName = this.getModelDisplayName(effectiveModel);
    const effortHtml = agent.effort ? `<span class="effort-badge">${escapeHtml(agent.effort)}</span>` : "";
    modelBtn.innerHTML = `<span class="model-label">${escapeHtml(displayName)}</span>${effortHtml}<svg class="model-chevron" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>`;
    if (models.length > 1 || agent.backend === "claude-cli") {
      modelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showModelMenu(e, agent, models, effectiveModel);
      });
    } else {
      modelBtn.style.cursor = "default";
    }
    this.agentInfoEl.appendChild(modelBtn);

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
        this.agentInfoEl.appendChild(barsDiv);
      }
    }
  }

  private showThrottleMenu(event: MouseEvent, agent: Agent, current: ThrottleState): void {
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
        this.applyThrottle(agent, state);
      });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    positionMenuNear(menu, event);
    setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 0);
  }

  private showModelMenu(event: MouseEvent, agent: Agent, models: BackendModel[], effectiveModel: string): void {
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
        if (m.name === effectiveModel) row.classList.add("active");
        row.innerHTML = `<span>${escapeHtml(m.display_name)}</span>${m.name === effectiveModel ? '<svg class="check-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ""}`;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          closeContextMenu();
          this.changeModel(agent, m.name);
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
          this.changeEffort(agent, e.value);
        });
        menu.appendChild(row);
      }
    }

    document.body.appendChild(menu);
    positionMenuNear(menu, event);
    setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 0);
  }

  private async changeEffort(agent: Agent, effort: string): Promise<void> {
    try {
      await updateAgent(agent.id, { effort: effort || null } as Partial<Agent>, this.scope);
      agent.effort = effort || null;
      this.renderAgentInfo();
    } catch (err) {
      console.error("Failed to change effort:", err);
    }
  }

  private getModelDisplayName(model: string): string {
    for (const models of Object.values(this.backendModels)) {
      const found = models.find((m) => m.name === model);
      if (found) return found.display_name;
    }
    return model;
  }

  private async applyThrottle(agent: Agent, state: ThrottleState): Promise<void> {
    const prev = this.agentThrottles[agent.id] || "disabled";
    try {
      // Tear down previous state
      if (prev === "stopped") await clearInterrupt(agent.id, this.scope);
      if (prev === "safe") await setSafeMode(agent.id, false, this.scope);

      // Enable/disable transitions
      const wasEnabled = prev !== "disabled";
      const willEnable = state !== "disabled";
      if (!wasEnabled && willEnable) {
        await setHeartbeatEnabled(agent.id, true, this.scope);
        agent.heartbeat_enabled = true;
      } else if (wasEnabled && !willEnable) {
        await setHeartbeatEnabled(agent.id, false, this.scope);
        agent.heartbeat_enabled = false;
      }

      // Set up new state
      if (state === "safe") await setSafeMode(agent.id, true, this.scope);
      if (state === "stopped") await setInterrupt(agent.id, "User paused from desktop app", this.scope);

      this.agentThrottles[agent.id] = state;
    } catch (err) {
      console.error("Failed to set throttle:", err);
    }
    this.renderAgentTabs();
    this.renderAgentInfo();
  }

  private async changeModel(agent: Agent, model: string): Promise<void> {
    // In a channel: set a per-(channel, agent) override (persists for THIS channel only).
    // Picking the agent's default clears the override. Outside a channel: change the
    // agent's default model (all channels without an override follow it).
    try {
      if (this.currentChannel) {
        const clearing = model === agent.model;
        await setChannelModelOverride(this.currentChannel.id, agent.id, clearing ? "" : model, this.scope);
        this.channelModelOverride = clearing ? null : model;
      } else {
        await updateAgent(agent.id, { model }, this.scope);
        agent.model = model;
      }
      this.renderAgentInfo();
    } catch (err) {
      console.error("Failed to change model:", err);
    }
  }

  /** Empty-channel onboarding card. Adapts to what's actually wired up so a
   *  fresh install tells the user the one thing they need next, instead of a
   *  bare "type something" against an unknown void. */
  private async renderWelcome(): Promise<void> {
    const agent = this.currentAgent;
    const card = document.createElement("div");
    card.className = "welcome-card";

    let authState: string | null = null;
    if (agent) {
      try {
        const st = await fetchBackendStatus(agent.backend, undefined, this.scope);
        authState = st.auth_status;
      } catch {
        authState = null;
      }
    }

    const server = this.scope.connection.id === "local"
      ? "this machine"
      : this.scope.connection.name;
    const title = `<div class="welcome-title">Welcome to ${escapeHtml(brand.displayName)}</div>`;

    if (agent && authState === "authenticated") {
      card.innerHTML =
        title +
        `<p><strong>${escapeHtml(agent.name)}</strong> is on duty in this channel — ` +
        `${escapeHtml(agent.model)} on ${escapeHtml(server)}, signed in and ready. ` +
        `It can run commands, read and edit files, and work alongside you here.</p>` +
        `<p>Type below to say hello.</p>`;
    } else if (agent) {
      const why =
        authState === "token_expired" ? "its AI sign-in has expired" :
        authState === "not_installed" ? "no AI backend is installed yet" :
        "no AI is signed in yet";
      card.innerHTML =
        title +
        `<p><strong>${escapeHtml(agent.name)}</strong> is bound to this channel, but ${why}.</p>` +
        `<p>Open Settings and add a credential under <em>Credentials</em>, then come back and say hello.</p>`;
      const btn = document.createElement("button");
      btn.className = "welcome-settings-btn";
      btn.textContent = "Open Settings";
      btn.addEventListener("click", () => openSettings(() => this.onReload?.()));
      card.appendChild(btn);
    } else {
      card.innerHTML =
        title +
        `<p>This channel has no agent yet. Open Settings to create one and connect an AI credential.</p>`;
      const btn = document.createElement("button");
      btn.className = "welcome-settings-btn";
      btn.textContent = "Open Settings";
      btn.addEventListener("click", () => openSettings(() => this.onReload?.()));
      card.appendChild(btn);
    }

    const hints = document.createElement("div");
    hints.className = "welcome-hints";
    hints.textContent = "⚙ credentials, agents & servers · >_ live terminal · 🔍 search";
    card.appendChild(hints);
    this.messagesEl.appendChild(card);
  }

  private async loadChannelModelOverride(channelId: string, agentId: string): Promise<void> {
    try {
      this.channelModelOverride = await getChannelModelOverride(channelId, agentId, this.scope);
    } catch {
      this.channelModelOverride = null;
    }
  }

  private async loadAgentThrottle(agent: Agent): Promise<void> {
    if (!agent.heartbeat_enabled) {
      this.agentThrottles[agent.id] = "disabled";
      return;
    }
    try {
      const [safeResp, intResp] = await Promise.all([
        getSafeMode(agent.id, this.scope),
        getInterrupt(agent.id, this.scope),
      ]);
      const safe = safeResp?.safe_mode ?? false;
      const interrupted = intResp?.interrupt_requested ?? false;
      this.agentThrottles[agent.id] = interrupted ? "stopped" : safe ? "safe" : "enabled";
    } catch {
      this.agentThrottles[agent.id] = "enabled";
    }
  }

  async selectAgent(agent: Agent): Promise<void> {
    this.currentAgent = agent;
    localStorage.setItem("lit-desktop-agent", agent.id);
    await this.loadAgentThrottle(agent);

    if (this.currentChannel) {
      try {
        await setChannelAgent(this.currentChannel.id, agent.id, this.scope);
      } catch {
        // Non-critical
      }
      await this.loadChannelModelOverride(this.currentChannel.id, agent.id);
    } else {
      this.channelModelOverride = null;
    }

    this.renderAgentTabs();
    this.renderAgentInfo();
  }

  private async loadChannelAgent(channelId: string): Promise<void> {
    this.channelModelOverride = null;
    try {
      const config = await getChannelConfig(channelId, this.scope);
      const agentId = config.agent_id as string | null;
      if (agentId) {
        const agent = this.agents.find((a) => a.id === agentId);
        if (agent) {
          this.currentAgent = agent;
          localStorage.setItem("lit-desktop-agent", agent.id);
          await this.loadChannelModelOverride(channelId, agent.id);
          this.renderAgentTabs();
          this.renderAgentInfo();
          return;
        }
      }
    } catch {
      // Config might not exist yet
    }

    if (this.agents.length > 0 && !this.currentAgent) {
      this.currentAgent = this.agents[0];
    }
    if (this.currentAgent) {
      // The channel had no binding (or a binding to an agent that no longer
      // exists) — persist the agent we're about to DISPLAY as selected, so the
      // UI never shows a watcher that isn't really watching. Without this, a
      // message sent here sits unread forever while the tabs look bound
      // (bitten live on jovai #general, 2026-07-22: stale bind to a dead
      // "new-agent" while the UI showed claude selected).
      setChannelAgent(channelId, this.currentAgent.id, this.scope).catch(() => {});
      await this.loadChannelModelOverride(channelId, this.currentAgent.id);
    }
    this.renderAgentTabs();
    this.renderAgentInfo();
  }

  // --- Folder opening ---

  async handleOpenFolder(): Promise<void> {
    const selected = await open({ directory: true, title: "Open project folder" });
    if (!selected) return;

    const folderPath = typeof selected === "string" ? selected : selected;
    try {
      const result = await openFolder(folderPath, undefined, this.scope);
      const newChannel: Channel = {
        id: result.id || result.name,
        name: result.name,
        unreadCount: 0,
      };
      if (!this.localChannels.find((c) => c.id === newChannel.id)) {
        this.localChannels.push(newChannel);
        this.saveLocalChannels();
      }
      this.renderSidebar(mergeChannels(this.localChannels, await fetchChannels(this.scope)));
      await this.openChannel(newChannel);
    } catch (err) {
      this.renderMessage({ role: "system", content: `Failed to open folder: ${err}` });
    }
  }

  // --- Sidebar rendering ---

  private renderSidebar(channels: Channel[]): void {
    this.channelList.innerHTML = "";

    // Section header with add menu
    const header = document.createElement("div");
    header.className = "section-header";
    header.innerHTML = `<span class="section-label">Channels</span><button class="icon-btn section-add-btn" title="Open folder">+</button><button class="icon-btn section-hide-btn" title="Hide navigation">&times;</button>`;
    header.querySelector(".section-add-btn")!.addEventListener("click", () => this.handleOpenFolder());
    header.querySelector(".section-hide-btn")!.addEventListener("click", () => this.collapseSidebar());
    this.channelList.appendChild(header);

    for (const ch of channels) {
      const item = document.createElement("div");
      item.className = "channel-item";
      item.dataset.channelId = ch.id;
      if (this.currentChannel?.id === ch.id) item.classList.add("active");

      const isStreaming = this.streamingChannels.has(ch.id);
      const hasUnread = ch.unreadCount > 0 && this.currentChannel?.id !== ch.id;

      let indicators = "";
      if (isStreaming) {
        indicators += `<span class="channel-dot streaming" title="Streaming"></span>`;
      } else if (hasUnread) {
        indicators += `<span class="channel-dot unread" title="${ch.unreadCount} unread"></span>`;
      }

      const badge = hasUnread ? `<span class="unread-badge">${ch.unreadCount}</span>` : "";
      item.innerHTML = `<span class="channel-icon">#</span><span class="channel-name">${escapeHtml(ch.name)}</span>${indicators}${badge}`;
      item.addEventListener("click", () => this.openChannel(ch));
      this.channelList.appendChild(item);
    }

    if (channels.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "No channels yet";
      this.channelList.appendChild(empty);
    }
  }

  private renderSidebarIndicators(): void {
    const items = this.channelList.querySelectorAll(".channel-item[data-channel-id]");
    items.forEach((item) => {
      const el = item as HTMLElement;
      const chId = el.dataset.channelId || "";
      let dot = el.querySelector(".channel-dot");
      const isStreaming = this.streamingChannels.has(chId);
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

  private async archiveCurrentChannel(): Promise<void> {
    if (!this.currentChannel) return;
    const archived = this.currentChannel;
    // Archive is PATCH /channels/{id} (folder channels: removes the symlink so it
    // drops from navigation). Await it before refreshing, or the refresh races the
    // archive and the channel reappears.
    try {
      await hostFetch(`${this.scope.connection.url}/mux/channels/${archived.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders(this.scope.connection) },
        body: JSON.stringify({ team: this.scope.team }),
      });
    } catch { /* offline / already gone */ }

    this.localChannels = this.localChannels.filter((c) => c.id !== archived.id);
    this.saveLocalChannels();
    localStorage.removeItem(this.scopedKey("lit-desktop-channel"));
    this.currentChannel = null;
    this.channelTitle.textContent = "Welcome";
    this.channelActionsEl.innerHTML = "";
    this.clearMessages();
    if (this.channelWs) { this.channelWs.close(); this.channelWs = null; }
    await this.refreshSidebar();
  }

  private renderChannelHeader(): void {
    if (!this.currentChannel) {
      this.channelActionsEl.innerHTML = "";
      return;
    }

    this.channelActionsEl.innerHTML = `<button class="kebab-btn header-btn" title="More">&#8942;</button>`;

    this.channelActionsEl.querySelector(".kebab-btn")?.addEventListener("click", (e) => {
      showContextMenu(e as MouseEvent, [
        { label: "Copy path", action: () => {
          if (this.currentChannel) navigator.clipboard.writeText(this.currentChannel.id).catch(() => {});
        }},
        { label: "Archive channel", action: () => this.archiveCurrentChannel() },
      ]);
    });
  }

  // --- Channel ---

  async openChannel(channel: Channel): Promise<void> {
    this.currentChannel = channel;
    this.channelTitle.textContent = channel.name;
    localStorage.setItem(this.scopedKey("lit-desktop-channel"), JSON.stringify({ id: channel.id, name: channel.name }));
    this.renderChannelHeader();
    // If the terminal is open, re-attach it to the newly-opened channel.
    if (isTerminalOpen()) {
      const host = document.getElementById("terminal-host");
      if (host) { openTerminal(host, channel.id); setTimeout(fitToGrid, 60); }
    }
    this.clearMessages();

    if (this.channelWs) {
      this.channelWs.close();
      this.channelWs = null;
    }

    await this.loadChannelAgent(channel.id);

    try {
      const messages = await fetchChannelMessages(channel.id, 50, this.scope);

      if (messages.length === 0) {
        void this.renderWelcome();
      } else {
        for (const msg of messages) {
          this.knownMessageIds.add(msg.id);
          this.renderMessage({
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

      // Non-fatal: a mark-read failure must not masquerade as a load failure.
      markChannelRead(channel.id, this.scope).catch(() => {});
      this.connectWebSocket(channel.id);
    } catch (err) {
      this.renderMessage({ role: "system", content: `Failed to load messages: ${err}` });
    }

    this.refreshSidebar();
    this.messageInput.focus();
  }

  // --- WebSocket ---

  private connectWebSocket(channelId: string): void {
    this.channelWs = createChannelWebSocket(channelId, this.scope);

    this.channelWs.onopen = () => {
      this.wsReconnectAttempt = 0;
      if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
      this.showConnectionStatus("connected");
    };

    this.channelWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Suppress an outbound (assistant) message that lands right after
        // stream_end — the live stream already rendered its content. Matches the
        // webapp's 5s window. Only active when the stream actually had content, so
        // a failed/empty stream never hides the authoritative persisted message.
        const suppressAfterStream = (direction?: string) =>
          direction !== "in" && this.lastStreamEndTime > 0 && Date.now() - this.lastStreamEndTime < 5000;

        if (data.type === "new_messages" && Array.isArray(data.messages)) {
          let added = false;
          for (const msg of data.messages) {
            if (this.knownMessageIds.has(msg.id)) continue;
            this.knownMessageIds.add(msg.id);
            if (suppressAfterStream(msg.direction)) continue;
            added = true;
            this.renderMessage({
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
            markChannelRead(channelId, this.scope).catch(() => {});
          }
        } else if (data.id && data.content && data.direction) {
          if (!this.knownMessageIds.has(data.id)) {
            this.knownMessageIds.add(data.id);
            if (!suppressAfterStream(data.direction)) {
              this.renderMessage({
                role: data.direction === "in" ? "user" : "assistant",
                content: data.content,
                id: data.id,
                from: data.from,
                timestamp: data.timestamp,
                file_path: data.file_path,
                metadata: data.metadata,
              });
              if (this.streamingEl && data.direction === "in") {
                this.messagesEl.appendChild(this.streamingEl);
              }
            }
            if (document.visibilityState === "visible") {
              markChannelRead(channelId, this.scope).catch(() => {});
            }
          }
        } else if (data.type === "thinking") {
          // Agent is connecting — show the streaming bubble early so a missed
          // stream_start never causes the first content frames to be dropped.
          if (!this.streamingEl) this.showTypingIndicator();
        } else if (data.type === "stream_start") {
          this.streamingChannels.add(channelId);
          this.activeStreamId = data.stream_id || null;
          this.renderSidebarIndicators();
          this.showTypingIndicator();
          this.cancelStreamBtn.style.display = "";
        } else if (data.type === "stream_chunk" && data.content) {
          this.appendStreamToken(data.content);
        } else if (data.type === "stream_replace") {
          // Full content each frame (JSONL-sourced bridge + replay). Previously
          // ignored by the desktop, so those frames never rendered live.
          this.setStreamContent(data.content || "");
        } else if (data.type === "stream_end") {
          this.streamingChannels.delete(channelId);
          this.activeStreamId = null;
          this.renderSidebarIndicators();
          // Prefer the authoritative content carried on stream_end (JSONL-sourced)
          // over the accumulated chunks — this recovers the full response even if
          // some live chunks were missed in transit.
          if (typeof data.content === "string" && data.content) {
            this.setStreamContent(data.content);
          }
          const hadContent = !!this.streamingText.trim();
          this.finalizeStream();
          this.lastStreamEndTime = hadContent ? Date.now() : 0;
          this.cancelStreamBtn.style.display = "none";
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    this.channelWs.onerror = () => {};
    this.channelWs.onclose = () => {
      if (!this.disposed && this.currentChannel?.id === channelId) {
        this.wsReconnect(channelId);
      }
    };
  }

  private wsReconnect(channelId: string): void {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.wsReconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(1.5, this.wsReconnectAttempt - 1), 15000);
    this.showConnectionStatus("reconnecting");
    this.wsReconnectTimer = setTimeout(() => {
      if (this.currentChannel?.id === channelId) {
        this.connectWebSocket(channelId);
      }
    }, delay);
  }

  private showConnectionStatus(status: "connected" | "reconnecting"): void {
    let indicator = this.root?.querySelector(".connection-status") as HTMLElement | null;
    if (status === "connected") {
      indicator?.remove();
      return;
    }
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "connection-status";
      this.contentHeader.appendChild(indicator);
    }
    indicator.textContent = `Reconnecting...`;
  }

  // --- Streaming ---

  private showTypingIndicator(): void {
    this.removeTypingIndicator();
    this.streamingText = "";
    const el = document.createElement("div");
    el.className = "message assistant streaming";
    const who = this.currentAgent?.name || "Agent";
    el.innerHTML = `<div class="message-header"><span class="message-author">${escapeHtml(who)}</span><span class="message-time">now</span></div><div class="message-content"><span class="typing-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>`;
    this.messagesEl.appendChild(el);
    if (!this.userIsScrolledUp) this.scrollToBottom();
    this.streamingEl = el;
  }

  // stream_chunk carries a delta (append); stream_replace carries the full
  // content each frame (the JSONL-sourced bridge emits these). The webapp's
  // channel view handles both — the desktop previously only handled append,
  // so replace frames rendered nothing live.
  private appendStreamToken(token: string): void {
    this.streamingText += token;
    this.renderStreamingText();
  }

  private setStreamContent(full: string): void {
    this.streamingText = full;
    this.renderStreamingText();
  }

  private renderStreamingText(): void {
    if (!this.streamingEl) this.showTypingIndicator();

    // During streaming, do a live parse and re-render parts
    const header = this.streamingEl!.querySelector(".message-header");
    this.streamingEl!.innerHTML = "";
    if (header) this.streamingEl!.appendChild(header);

    const parsed = parseMessageContent(this.streamingText);
    renderContentParts(this.streamingEl!, parsed.parts, "assistant");

    // If there are active tool groups, show "Working..." on the last one
    const toolGroups = this.streamingEl!.querySelectorAll(".tool-group");
    if (toolGroups.length > 0) {
      const lastGroup = toolGroups[toolGroups.length - 1];
      const label = lastGroup.querySelector(".tool-group-label");
      if (label && hasToolDelimiters(this.streamingText)) {
        const lastToolJson = this.streamingText.lastIndexOf("\x02TOOLJSON");
        const lastToolEnd = this.streamingText.lastIndexOf("\x03");
        const lastResultEnd = this.streamingText.lastIndexOf("[/TOOL_RESULT]");
        if (lastToolJson > lastResultEnd && lastToolJson > lastToolEnd) {
          label.textContent = "Working…";
          (label as HTMLElement).style.fontStyle = "italic";
        }
      }
    }

    if (!this.userIsScrolledUp) this.scrollToBottom();
  }

  private finalizeStream(): void {
    if (this.streamingEl && this.streamingText) {
      // Re-render with full parsing (tool calls become collapsible sections)
      const parsed = parseMessageContent(this.streamingText);
      const contentParent = this.streamingEl;

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

      this.streamingEl.classList.remove("streaming");
    }
    this.streamingEl = null;
    this.streamingText = "";
    this.removeTypingIndicator();
  }

  private removeTypingIndicator(): void {
    const dots = this.messagesEl.querySelector(".typing-dots");
    if (dots) {
      const msg = dots.closest(".message");
      if (msg && !this.streamingText) msg.remove();
    }
  }

  // --- Message actions ---

  private async deleteMessage(channelId: string, messageId: string, el: HTMLElement): Promise<void> {
    try {
      await hostFetch(`${this.scope.connection.url}/mux/channels/${channelId}/messages/${messageId}`, {
        method: "DELETE",
        headers: authHeaders(this.scope.connection),
      });
      el.remove();
      this.knownMessageIds.delete(messageId);
    } catch (err) {
      console.error("Failed to delete message:", err);
    }
  }

  // --- Image paste/upload ---

  private static readonly MAX_PENDING_IMAGES = 3;

  private renderPendingImages(): void {
    let row = this.root?.querySelector(".pending-images-row") as HTMLElement | null;
    if (this.pendingImageDataUrls.length === 0) {
      row?.remove();
      return;
    }
    if (!row) {
      row = document.createElement("div");
      row.className = "pending-images-row";
      this.inputRow.parentElement!.insertBefore(row, this.inputRow);
    }
    row.innerHTML = "";
    for (let i = 0; i < this.pendingImageDataUrls.length; i++) {
      const wrap = document.createElement("div");
      wrap.className = "pending-image-preview";
      wrap.innerHTML = `<img src="${this.pendingImageDataUrls[i]}" /><button class="pending-image-remove" title="Remove">&times;</button>`;
      wrap.querySelector("button")!.addEventListener("click", () => {
        this.pendingImageFiles.splice(i, 1);
        this.pendingImageDataUrls.splice(i, 1);
        this.renderPendingImages();
      });
      row.appendChild(wrap);
    }
  }

  private async handlePaste(e: ClipboardEvent): Promise<void> {
    // Try legacy clipboardData.items first (works in Chromium-based webviews)
    const items = e.clipboardData?.items;
    let foundImage = false;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (this.pendingImageFiles.length >= ChatPanel.MAX_PENDING_IMAGES) break;
        const item = items[i];
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          foundImage = true;
          const file = item.getAsFile();
          if (!file) continue;
          this.pendingImageFiles.push(file);
          const reader = new FileReader();
          reader.onload = () => {
            this.pendingImageDataUrls.push(reader.result as string);
            this.renderPendingImages();
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
          if (this.pendingImageFiles.length >= ChatPanel.MAX_PENDING_IMAGES) break;
          const imageType = clipItem.types.find(t => t.startsWith("image/"));
          if (imageType) {
            e.preventDefault();
            const blob = await clipItem.getType(imageType);
            const file = new File([blob], `clipboard-${Date.now()}.png`, { type: imageType });
            this.pendingImageFiles.push(file);
            const reader = new FileReader();
            reader.onload = () => {
              this.pendingImageDataUrls.push(reader.result as string);
              this.renderPendingImages();
            };
            reader.readAsDataURL(file);
          }
        }
      } catch {
        // Clipboard read not available or denied
      }
    }
  }

  // --- Send ---

  private async handleSend(): Promise<void> {
    const text = this.messageInput.value.trim();
    if (!text && this.pendingImageFiles.length === 0) return;
    if (!this.currentChannel) return;

    this.messageInput.value = "";
    autoResize(this.messageInput);

    let content = text;

    // Upload pending images
    if (this.pendingImageFiles.length > 0) {
      const files = [...this.pendingImageFiles];
      this.pendingImageFiles = [];
      this.pendingImageDataUrls = [];
      this.renderPendingImages();

      const imageMarkdowns: string[] = [];
      const imageNames: string[] = [];
      for (const file of files) {
        try {
          const result = await uploadImage(file, this.currentChannel.id, this.scope);
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

    this.renderMessage({ role: "user", content, timestamp: new Date().toISOString() });
    if (this.streamingEl) {
      this.messagesEl.appendChild(this.streamingEl);
    }

    try {
      await postChannelMessage(this.currentChannel.id, content, this.scope);
    } catch (err) {
      this.renderMessage({ role: "system", content: `Failed to send: ${err}` });
    }
  }

  // --- Refresh ---

  private async refreshSidebar(): Promise<void> {
    try {
      const remote = await fetchChannels(this.scope);
      this.channelListCache = remote;
      this.renderSidebar(mergeChannels(this.localChannels, remote));
    } catch {
      // Not critical
    }
  }

  private async refreshAgents(): Promise<void> {
    try {
      this.agents = await fetchAgents(this.scope);
      // Refresh throttle state for current agent
      if (this.currentAgent) {
        await this.loadAgentThrottle(this.currentAgent);
      }
      // Refresh usage for current agent's backend
      if (this.currentAgent) {
        try {
          this.usageReports[this.currentAgent.backend] = await fetchUsage(this.currentAgent.backend, this.scope);
        } catch { /* non-critical */ }
      }
      this.renderAgentTabs();
      this.renderAgentInfo();
    } catch {
      // Not critical
    }
  }

  // --- Initial data load (chat's share of app startup) ---

  async loadInitialData(): Promise<void> {
    try {
      // Fetch agents, models, and channels in parallel
      const [agentsData, modelsData, remote] = await Promise.all([
        fetchAgents(this.scope),
        fetchModels(this.scope).catch(() => ({})),
        fetchChannels(this.scope),
      ]);

      this.agents = agentsData;
      this.backendModels = modelsData;

      if (this.agents.length > 0) {
        const savedAgentId = localStorage.getItem("lit-desktop-agent");
        this.currentAgent = (savedAgentId && this.agents.find(a => a.id === savedAgentId)) || this.agents[0];
        // Load throttle state for all agents in parallel
        await Promise.all(this.agents.map((a) => this.loadAgentThrottle(a)));
        // Load usage for unique backends
        const backends = [...new Set(this.agents.map((a) => a.backend))];
        await Promise.all(
          backends.map(async (b) => {
            try {
              this.usageReports[b] = await fetchUsage(b, this.scope);
            } catch {
              // Usage may not be available for all backends
            }
          })
        );
      }

      this.renderAgentTabs();
      this.renderAgentInfo();

      this.channelListCache = remote;
      // Reconcile: drop local channels the server no longer recognizes (stale
      // cross-backend ghosts). Open-Folder registers server-side and appears in
      // navigation, so real channels survive; only ghosts (which 404 on send) go.
      const remoteIds = new Set(remote.map((c) => c.id));
      const ghosts = this.localChannels.filter((c) => !remoteIds.has(c.id));
      if (ghosts.length) {
        this.localChannels = this.localChannels.filter((c) => remoteIds.has(c.id));
        this.saveLocalChannels();
        console.log("[channels] pruned stale local channels:", ghosts.map((c) => c.id));
      }
      const all = mergeChannels(this.localChannels, remote);
      this.renderSidebar(all);

      if (this.agents.length === 0) {
        this.renderOnboarding();
        return;
      }

      // Restore last active channel, or fall back to first
      let target = all[0] || null;
      try {
        const rawSaved = localStorage.getItem(this.scopedKey("lit-desktop-channel"))
          ?? (this.scope.connection.id === "local" ? localStorage.getItem("lit-desktop-channel") : null);
        const saved = JSON.parse(rawSaved || "");
        if (saved?.id) {
          const match = all.find((c) => c.id === saved.id);
          if (match) target = match;
        }
      } catch { /* no saved channel */ }

      if (target) {
        await this.openChannel(target);
      } else {
        this.clearMessages();
        this.renderMessage({ role: "system", content: "Open a project folder to get started. Click \"+ Open Folder\" in the sidebar." });
      }
    } catch (err) {
      this.renderMessage({ role: "system", content: `Failed to load data: ${err}` });
    }
  }
}
