import {
  checkConnection,
  fetchAgents,
  fetchChannels,
  fetchChannelMessages,
  fetchMessagesAround,
  fetchCalendarDates,
  fetchCalendarDay,
  fetchMessageContent,
  type CalendarDayMessage,
  postChannelMessage,
  createChannelWebSocket,
  markChannelRead,
  openFolder,
  setChannelAgent,
  getChannelConfig,
  getChannelModelOverride,
  setChannelModelOverride,
  fetchModels,
  fetchApps,
  type AppWidget,
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
  readServerFile,
  searchChannelMessages,
  fetchTeams,
  createTeam,
  getActiveTeam,
  setActiveTeam,
  authHeaders,
  getConnections,
  getActiveConnection,
  setActiveConnectionId,
  activeScope,
  type Scope,
  type TeamInfo,
  type Agent,
  type Channel,
  type BackendModel,
  type UsageReport,
  type ThrottleState,
} from "./api";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { Command as ShellCommand, type Child } from "@tauri-apps/plugin-shell";
import { renderMarkdown } from "./markdown";
import { openSettings } from "./settings";
import { openTerminal, closeTerminal, isTerminalOpen, fitToGrid } from "./terminal";
import { brand } from "./brand";
import { WindowManager } from "./window-manager";
import { registerPanel } from "./panel-host";
import { mountGraphView } from "./graph-view";
import "dockview-core/dist/styles/dockview.css";

// --- Docking shell (Step 1: chat becomes a dockview panel) ---
const wm = new WindowManager();
const DOCK_LAYOUT_KEY = "lit-desktop-dock-layout";

// The chat panel relocates the existing #chat-panel-root DOM into the panel host.
// Moving (not recreating) the nodes preserves every element ref/handler in this
// file — messagesEl, inputArea, agent-tabs, etc. all keep resolving.
registerPanel("chat", () => ({
  mount(host: HTMLElement) {
    const root = document.getElementById("chat-panel-root");
    if (root) {
      root.hidden = false;
      host.appendChild(root);
    }
  },
  // Persistent panel — never disposed.
}));

// The viewer panel renders a file's text beside the chat — markdown rendered,
// other files syntax-highlighted in a code block. The first "see my work next to
// the conversation" surface; a Monaco editor/diff comes later.
registerPanel("viewer", () => ({
  mount(host: HTMLElement, params: Record<string, any>) {
    const path = String(params.path || "");
    const body = document.createElement("div");
    body.className = "viewer-body";
    body.textContent = `Loading ${path}…`;
    host.appendChild(body);
    readServerFile(path)
      .then((content) => {
        const isMd = /\.(md|markdown)$/i.test(path);
        const ext = (path.split(".").pop() || "").toLowerCase();
        const md = isMd ? content : "```" + ext + "\n" + content + "\n```";
        body.innerHTML = renderMarkdown(md);
      })
      .catch((e) => {
        body.classList.add("viewer-error");
        body.textContent = `Couldn't open ${path}: ${e?.message || e}`;
      });
  },
}));

// A team app (published from /data/{team}/apps or the shared everyone catalog)
// rendered as an iframe — the desktop's counterpart to the webapp's team-apps
// grid widget. Only 'iframe' apps render; other types aren't wired up yet.
registerPanel("app", () => ({
  mount(host: HTMLElement, params: Record<string, any>) {
    const url = String(params.url || "");
    if (!url) {
      host.textContent = "This app has no URL to open.";
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.className = "app-panel-iframe";
    iframe.src = url.startsWith("http") ? url : `${chatScope.connection.url}${url}`;
    host.appendChild(iframe);
  },
}));

/** Open (or focus) a team app in its own panel. */
function openApp(app: AppWidget): void {
  if (app.type !== "iframe" || !app.url) {
    renderMessage({ role: "system", content: `"${app.title}" isn't a supported app type in the desktop yet.` });
    return;
  }
  const id = `app-${app.id}`;
  if (!wm.hasPanel(id)) {
    wm.addPanel({ id, component: "app", title: app.title, params: { url: app.url } });
  }
  wm.focusPanel(id);
}

// Channel text search — a dock panel with a debounced search box + results.
// Backed by GET /channels/{id}/messages/search. Clicking a hit that's currently
// loaded scrolls to it and flashes it; older hits still show their excerpt.
registerPanel("search", () => {
  let textDebounce: ReturnType<typeof setTimeout> | undefined;
  let graphDispose: (() => void) | null = null;
  return {
    mount(host: HTMLElement) {
      host.innerHTML = `
        <div class="search-panel">
          <div class="search-tabs">
            <button class="search-tab active" data-tab="text" type="button">Text</button>
            <button class="search-tab" data-tab="calendar" type="button">Calendar</button>
            <button class="search-tab" data-tab="graph" type="button">Knowledge Graph</button>
          </div>
          <div class="search-tab-body" data-body="text"></div>
          <div class="search-tab-body" data-body="calendar" hidden></div>
          <div class="search-tab-body" data-body="graph" hidden></div>
        </div>`;
      const tabs = Array.from(host.querySelectorAll(".search-tab")) as HTMLElement[];
      const bodies = Array.from(host.querySelectorAll(".search-tab-body")) as HTMLElement[];
      const bodyFor = (n: string) => bodies.find((b) => b.dataset.body === n)!;
      let calendarLoaded = false;
      let graphLoaded = false;

      const select = (name: string) => {
        tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
        bodies.forEach((b) => (b.hidden = b.dataset.body !== name));
        if (name === "calendar" && !calendarLoaded) { calendarLoaded = true; mountCalendarView(bodyFor("calendar")); }
        if (name === "graph" && !graphLoaded && currentChannel) {
          graphLoaded = true;
          graphDispose = mountGraphView(bodyFor("graph"), {
            channelId: currentChannel.id,
            jumpToMessage,
            escapeHtml,
          });
        }
        if (name === "text") (host.querySelector(".search-input") as HTMLInputElement | null)?.focus();
      };
      tabs.forEach((t) => t.addEventListener("click", () => select(t.dataset.tab!)));

      // --- Text tab ---
      bodyFor("text").innerHTML = `
        <div class="search-panel-head">
          <input type="text" class="search-input" placeholder="Search this channel…" spellcheck="false" />
          <label class="search-regex" title="Regular expression"><input type="checkbox" class="search-regex-cb" /> .*</label>
        </div>
        <div class="search-status"></div>
        <div class="search-results"></div>`;
      const input = bodyFor("text").querySelector(".search-input") as HTMLInputElement;
      const regexCb = bodyFor("text").querySelector(".search-regex-cb") as HTMLInputElement;
      const status = bodyFor("text").querySelector(".search-status") as HTMLElement;
      const list = bodyFor("text").querySelector(".search-results") as HTMLElement;

      const run = async () => {
        const q = input.value.trim();
        list.innerHTML = "";
        if (!q) { status.textContent = ""; return; }
        if (!currentChannel) { status.textContent = "Open a channel to search."; return; }
        status.textContent = "Searching…";
        try {
          const results = await searchChannelMessages(currentChannel.id, q, regexCb.checked, chatScope);
          status.textContent = results.length
            ? `${results.length} result${results.length === 1 ? "" : "s"}`
            : "No matches";
          for (const r of results) {
            const date = r.ref.split("/")[1] || "";
            const row = document.createElement("div");
            row.className = "search-result";
            row.innerHTML =
              `<div class="search-result-date">${escapeHtml(date)}</div>` +
              `<div class="search-result-excerpt">${highlightMatch(escapeHtml(r.excerpt), q, regexCb.checked)}</div>`;
            row.addEventListener("click", () => jumpToMessage(r.message_id));
            list.appendChild(row);
          }
        } catch {
          status.textContent = "Search failed.";
        }
      };
      input.addEventListener("input", () => { clearTimeout(textDebounce); textDebounce = setTimeout(run, 400); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(textDebounce); run(); } });
      regexCb.addEventListener("change", run);
      setTimeout(() => input.focus(), 30);

      // --- Knowledge Graph tab: lazily mounted on first select (see `select`). ---
      bodyFor("graph").innerHTML =
        `<div class="search-placeholder">Open a channel to explore its knowledge graph.</div>`;
    },
    dispose() { clearTimeout(textDebounce); graphDispose?.(); },
  };
});

/** Calendar view: a month heatmap of activity; click a day to list its messages,
 *  click a message to jump to it (reuses the seekable-timeline jump). */
function mountCalendarView(host: HTMLElement): void {
  if (!currentChannel) { host.innerHTML = `<div class="search-placeholder">Open a channel first.</div>`; return; }
  const channelId = currentChannel.id;
  // Two views (master-detail): the picker (month → hour grid) and the results
  // list with a Back button. Same drill-down model as the webapp calendar.
  host.innerHTML = `
    <div class="cal-picker">
      <div class="cal-head">
        <button class="cal-nav cal-prev" type="button">&#8249;</button>
        <span class="cal-title"></span>
        <button class="cal-nav cal-next" type="button">&#8250;</button>
      </div>
      <div class="cal-dow"></div>
      <div class="cal-grid"><div class="search-status">Loading…</div></div>
      <div class="cal-hours-wrap"></div>
    </div>
    <div class="cal-results" hidden>
      <div class="cal-results-head">
        <button class="cal-back" type="button">&#8249; Back</button>
        <span class="cal-results-title"></span>
      </div>
      <div class="cal-msg-list"></div>
    </div>`;
  const pickerEl = host.querySelector(".cal-picker") as HTMLElement;
  const resultsEl = host.querySelector(".cal-results") as HTMLElement;
  const titleEl = host.querySelector(".cal-title") as HTMLElement;
  const dowEl = host.querySelector(".cal-dow") as HTMLElement;
  const gridEl = host.querySelector(".cal-grid") as HTMLElement;
  const hoursWrap = host.querySelector(".cal-hours-wrap") as HTMLElement;
  const resultsTitle = host.querySelector(".cal-results-title") as HTMLElement;
  const listEl = host.querySelector(".cal-msg-list") as HTMLElement;
  dowEl.innerHTML = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span>${d}</span>`).join("");

  let dates: Record<string, number> = {};
  let view = new Date();
  let selectedDate = "";
  let dayMessages: CalendarDayMessage[] = [];
  let dayObserver: IntersectionObserver | null = null;

  const iso = (y: number, m: number, d: number) =>
    `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // timestamps are ISO strings ("2026-07-13T16:01:09…"), so Date parses them directly.
  const hourOf = (ts: string): number | null => { const d = new Date(ts); return isNaN(d.getTime()) ? null : d.getHours(); };
  const timeOf = (ts: string): string => { const d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
  const hourLabel = (h: number) => `${(h % 12) || 12} ${h < 12 ? "AM" : "PM"}`;
  const formatDayLong = (d: string) => { const dt = new Date(d + "T00:00:00"); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }); };

  // --- Results view (detail) ---
  const renderList = (subset: CalendarDayMessage[]) => {
    dayObserver?.disconnect();
    listEl.innerHTML = subset.map((mm) => {
      const who = mm.direction === "in" ? "You" : (mm.from || "agent");
      const ref = `${channelId}/${selectedDate}/${mm.filename}`;
      return `<div class="cal-msg" data-id="${escapeHtml(mm.id)}" data-ref="${escapeHtml(ref)}">` +
        `<div class="cal-msg-head"><span class="cal-msg-time">${escapeHtml(timeOf(mm.timestamp))}</span><span class="cal-msg-who">${escapeHtml(who)}</span></div>` +
        `<div class="cal-msg-preview" data-preview></div></div>`;
    }).join("") || `<div class="search-status">No messages.</div>`;
    listEl.querySelectorAll(".cal-msg").forEach((r) =>
      r.addEventListener("click", () => jumpToMessage((r as HTMLElement).dataset.id)));
    dayObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        dayObserver!.unobserve(el);
        const pv = el.querySelector("[data-preview]") as HTMLElement;
        fetchMessageContent(el.dataset.ref!, chatScope).then((raw) => { if (raw) pv.textContent = messagePreview(raw); }).catch(() => {});
      }
    }, { root: listEl, rootMargin: "150px" });
    listEl.querySelectorAll(".cal-msg").forEach((el) => dayObserver!.observe(el));
  };
  const showResults = (subset: CalendarDayMessage[], label: string) => {
    resultsTitle.textContent = `${formatDayLong(selectedDate)} · ${label}`;
    listEl.scrollTop = 0;
    pickerEl.hidden = true;
    resultsEl.hidden = false;
    renderList(subset);
  };
  const showPicker = () => { dayObserver?.disconnect(); resultsEl.hidden = true; pickerEl.hidden = false; };
  (host.querySelector(".cal-back") as HTMLElement).addEventListener("click", showPicker);

  // --- Picker view (master): month grid → the day's hour grid ---
  const renderHours = () => {
    const hourCounts = new Array(24).fill(0);
    for (const m of dayMessages) { const h = hourOf(m.timestamp); if (h !== null) hourCounts[h]++; }
    const hourCells = hourCounts.map((c, h) =>
      `<button class="cal-hour" data-hour="${h}" ${c ? "" : "disabled"} type="button">` +
        `<span class="cal-hour-label">${hourLabel(h)}</span>` +
        (c ? `<span class="cal-hour-count">${c}</span>` : "") +
      `</button>`).join("");
    hoursWrap.innerHTML =
      `<div class="cal-day-title"><span>${escapeHtml(formatDayLong(selectedDate))} · ${dayMessages.length} message${dayMessages.length === 1 ? "" : "s"}</span>` +
        `<button class="cal-viewall" type="button">View all</button></div>` +
      `<div class="cal-hours">${hourCells}</div>`;
    (hoursWrap.querySelector(".cal-viewall") as HTMLElement).addEventListener("click", () => showResults(dayMessages, "all day"));
    hoursWrap.querySelectorAll(".cal-hour").forEach((btn) => {
      if ((btn as HTMLButtonElement).disabled) return;
      btn.addEventListener("click", () => {
        const h = (btn as HTMLElement).dataset.hour!;
        showResults(dayMessages.filter((m) => String(hourOf(m.timestamp)) === h), hourLabel(Number(h)));
      });
    });
  };

  const loadDay = async (date: string) => {
    selectedDate = date;
    gridEl.querySelectorAll(".cal-cell").forEach((c) => c.classList.toggle("selected", (c as HTMLElement).dataset.date === date));
    hoursWrap.innerHTML = `<div class="search-status">Loading…</div>`;
    try { dayMessages = await fetchCalendarDay(channelId, date, chatScope); }
    catch { hoursWrap.innerHTML = `<div class="search-status">Failed to load day.</div>`; return; }
    renderHours();
  };

  const renderGrid = () => {
    const y = view.getFullYear(), m = view.getMonth();
    titleEl.textContent = view.toLocaleString(undefined, { month: "long", year: "numeric" });
    const firstDow = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const max = Math.max(1, ...Object.values(dates));
    let html = "";
    for (let i = 0; i < firstDow; i++) html += `<span class="cal-cell empty"></span>`;
    for (let d = 1; d <= days; d++) {
      const key = iso(y, m, d);
      const c = dates[key] || 0;
      const intensity = c ? (0.15 + 0.5 * Math.min(1, c / max)).toFixed(2) : "0";
      const style = c ? ` style="background:rgba(97,175,239,${intensity})" title="${c} messages"` : "";
      html += `<button class="cal-cell${c ? " active" : ""}${key === selectedDate ? " selected" : ""}" data-date="${key}"${style} type="button" ${c ? "" : "disabled"}>${d}</button>`;
    }
    gridEl.innerHTML = html;
    gridEl.querySelectorAll(".cal-cell.active").forEach((cell) =>
      cell.addEventListener("click", () => loadDay((cell as HTMLElement).dataset.date!)));
  };

  host.querySelector(".cal-prev")!.addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderGrid(); });
  host.querySelector(".cal-next")!.addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderGrid(); });

  fetchCalendarDates(channelId, chatScope).then((d) => {
    dates = d;
    const keys = Object.keys(dates).sort();
    if (keys.length) {
      const [yy, mm] = keys[keys.length - 1].split("-").map(Number);
      view = new Date(yy, mm - 1, 1);
    }
    renderGrid();
  }).catch(() => { gridEl.innerHTML = `<div class="search-status">Failed to load calendar.</div>`; });
}

/** Open (or focus) the channel search panel and focus its input. */
function openSearch(): void {
  if (!wm.hasPanel("search")) {
    wm.addPanel({ id: "search", component: "search", title: "Search" });
  }
  wm.focusPanel("search");
  setTimeout(() => (document.querySelector(".search-input") as HTMLInputElement | null)?.focus(), 40);
}

/** Jump to a message. If it's already loaded, scroll + flash. If it's back in
 *  history, load a window centered on it (seekable timeline), re-render, then
 *  snap to it — same model as the webapp. */
async function jumpToMessage(id?: string): Promise<void> {
  if (!id || !currentChannel) return;
  const sel = `#messages [data-message-id="${CSS.escape(id)}"]`;
  let el = document.querySelector(sel) as HTMLElement | null;

  if (!el) {
    try {
      const { messages, hasNewer } = await fetchMessagesAround(currentChannel.id, id, 50, chatScope);
      if (messages.length) {
        clearMessages();
        if (hasNewer) renderHistoryBanner(currentChannel);
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
        el = document.querySelector(sel);
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
function renderHistoryBanner(channel: Channel): void {
  const banner = document.createElement("div");
  banner.className = "history-banner";
  banner.innerHTML =
    `<span>Viewing history</span>` +
    `<button class="history-latest-btn" type="button">Jump to latest &#8595;</button>`;
  banner.querySelector(".history-latest-btn")!.addEventListener("click", () => openChannel(channel));
  messagesEl.appendChild(banner);
}

/** Wrap literal matches of the query in <mark> (skipped in regex mode). */
function highlightMatch(escapedText: string, q: string, isRegex: boolean): string {
  if (!q || isRegex) return escapedText;
  const escQ = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return escapedText.replace(new RegExp(escQ, "ig"), (m) => `<mark>${m}</mark>`);
  } catch {
    return escapedText;
  }
}

/** Clean one-line preview from a raw message .md file — drop the header block
 *  (ID/TIMESTAMP/FROM/DIRECTION), the trailing LINKS: footer, and collapse space. */
function messagePreview(raw: string): string {
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && (/^(ID|TIMESTAMP|FROM|DIRECTION):/.test(lines[i]) || lines[i].trim() === "")) i++;
  let body = lines.slice(i).join("\n");
  const linkIdx = body.lastIndexOf("\nLINKS: ");
  if (linkIdx !== -1) body = body.slice(0, linkIdx);
  return body.replace(/\s+/g, " ").trim().slice(0, 160);
}

function currentThemeMode(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function setupDock(): void {
  const container = document.getElementById("dockview-container");
  if (!container) return;
  wm.setLayoutStorageKey(DOCK_LAYOUT_KEY);
  wm.init(container);
  wm.setTheme(currentThemeMode());
  // Restore a saved layout; otherwise open the chat panel fresh. Always guarantee
  // the chat panel exists (it's the shell's anchor).
  const restored = wm.restore();
  if (!restored || !wm.hasPanel("chat")) {
    wm.addPanel({ id: "chat", component: "chat", title: "Chat", persistent: true });
  }
}

// The app-level toolbar. A favorites rail (commands pinned from the F1 palette)
// plus the fixed global controls (settings, theme). It docks to a window edge and
// #content reflows around it — position is set via right-click, not drag, since
// it's a set-once preference. Same edge model as the webapp menubar.
const TOOLBAR_EDGE_KEY = "lit-desktop-toolbar-edge";
const TOOLBAR_FAV_KEY = "lit-desktop-toolbar-favorites";
type ToolbarEdge = "top" | "bottom" | "left" | "right";
const TOOLBAR_EDGES: ToolbarEdge[] = ["top", "bottom", "left", "right"];

function toolbarFavorites(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TOOLBAR_FAV_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function isFavorite(id: string): boolean { return toolbarFavorites().includes(id); }
function toggleFavorite(id: string): void {
  const favs = toolbarFavorites();
  const i = favs.indexOf(id);
  if (i >= 0) favs.splice(i, 1); else favs.push(id);
  localStorage.setItem(TOOLBAR_FAV_KEY, JSON.stringify(favs));
  renderToolbarFavorites();
}
/** Render pinned commands as buttons in the toolbar. Stale ids (a channel/agent
 *  that no longer exists) silently drop since the command won't resolve. */
function renderToolbarFavorites(): void {
  const host = document.getElementById("toolbar-favorites");
  if (!host) return;
  host.innerHTML = "";
  const byId = new Map(getCommands().map((c) => [c.id, c]));
  for (const id of toolbarFavorites()) {
    const cmd = byId.get(id);
    if (!cmd) continue;
    const btn = document.createElement("button");
    btn.className = "icon-btn header-btn toolbar-fav";
    btn.title = cmd.label;
    btn.textContent = cmd.icon;
    btn.addEventListener("click", () => cmd.action());
    // Right-click a favorite to unpin it directly.
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(id);
    });
    host.appendChild(btn);
  }
}

function setToolbarEdge(edge: ToolbarEdge): void {
  document.getElementById("app")?.setAttribute("data-toolbar-edge", edge);
  localStorage.setItem(TOOLBAR_EDGE_KEY, edge);
}

/** Right-click menu on the toolbar: pick which edge it docks to. */
function showToolbarPositionMenu(x: number, y: number): void {
  document.getElementById("toolbar-ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "toolbar-ctx-menu";
  menu.className = "ctx-menu";
  const label = document.createElement("div");
  label.className = "ctx-menu-label";
  label.textContent = "Toolbar position";
  menu.appendChild(label);
  const current = document.getElementById("app")?.getAttribute("data-toolbar-edge");
  for (const edge of TOOLBAR_EDGES) {
    const item = document.createElement("div");
    item.className = "ctx-menu-item" + (edge === current ? " active" : "");
    item.textContent = edge.charAt(0).toUpperCase() + edge.slice(1);
    item.addEventListener("click", () => { setToolbarEdge(edge); menu.remove(); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + "px";
  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

function setupAppToolbar(): void {
  const app = document.getElementById("app");
  const bar = document.getElementById("app-toolbar");
  if (!app || !bar) return;

  const saved = localStorage.getItem(TOOLBAR_EDGE_KEY) as ToolbarEdge | null;
  app.setAttribute("data-toolbar-edge", saved && TOOLBAR_EDGES.includes(saved) ? saved : "top");

  const addBtn = document.getElementById("toolbar-add");
  if (addBtn) addBtn.addEventListener("click", () => openCommandPalette());

  bar.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showToolbarPositionMenu(e.clientX, e.clientY);
  });

  renderToolbarFavorites();
}

/** Open a file in a viewer panel beside the chat (focus it if already open). */
function openViewer(path: string): void {
  const id = `viewer:${path}`;
  if (wm.hasPanel(id)) {
    wm.focusPanel(id);
    return;
  }
  const title = path.split("/").pop() || path;
  wm.addPanel({ id, component: "viewer", title, params: { path } });
}

async function handleOpenFile(): Promise<void> {
  const sel = await open({ multiple: false, title: "Open a file" });
  if (typeof sel === "string") openViewer(sel);
}

let backendProcess: Child | null = null;
// Set by startBackend() when the backend fails to start, so the failure dialog
// can show the real reason (e.g. a Tauri spawn rejection) instead of only
// pointing at a log that's empty when the backend never ran.
let backendStartError: string | null = null;

// Where the backend tees its stdout/stderr (see lit-server-entry.py). Kept in
// sync with the _BASE path baked into the frozen backend.
async function backendLogPath(): Promise<string> {
  try {
    return await join(await homeDir(), ".local", "share", "lit-desktop", "logs", "backend.log");
  } catch {
    return "~/.local/share/lit-desktop/logs/backend.log";
  }
}

async function startBackend(): Promise<boolean> {
  backendStartError = null;
  if (await checkConnection()) return true;

  try {
    const cmd = ShellCommand.sidecar(`binaries/${brand.sidecarName}`);
    cmd.on("close", (data) => {
      console.log(`[backend] exited with code ${data.code}`);
      backendProcess = null;
    });
    cmd.stdout.on("data", (line) => console.log(`[backend] ${line}`));
    cmd.stderr.on("data", (line) => console.warn(`[backend] ${line}`));
    backendProcess = await cmd.spawn();
    console.log("[backend] spawned, waiting for health check...");
  } catch (e) {
    // A spawn rejection (e.g. a shell-scope/capability denial) never writes to
    // the backend log — the backend never ran — so capture it for the UI.
    backendStartError = `Could not launch the backend process: ${String((e as any)?.message ?? e)}`;
    console.error("[backend] failed to spawn sidecar:", e);
    return false;
  }

  // 90s, not 30s: a Windows first-run cold start extracts the onefile and
  // Defender scans every file, which can exceed 30s on the very first launch.
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await checkConnection()) {
      console.log("[backend] ready");
      return true;
    }
  }
  backendStartError = "The backend started but did not become reachable within 90 seconds.";
  console.error("[backend] timed out waiting for server");
  return false;
}

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

// The chat view's scope — which (server, team) this view stands in. Stage 2a of
// componentization: every chat API call threads this explicitly, so the future
// per-tab ChatPanel just owns one of these instead of the module owning one.
let chatScope: Scope = activeScope();

let currentChannel: Channel | null = null;
let currentAgent: Agent | null = null;
// Per-(channel, currentAgent) model override — null means "follow the agent's default".
// Reloaded whenever the open channel or its bound agent changes.
let channelModelOverride: string | null = null;
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

// --- Team rail ---
// Workspace separation: channels, agents, and credentials all scope to the
// active team (backend: ?team=<slug> → ~/.lit/data/{team}/). Ported from the
// webapp toolbar quick-switcher: one initial-button per team at the end of
// the app toolbar, active team highlighted, one-click switch. Selection
// persists in localStorage.

let teams: TeamInfo[] = [];

async function renderTeamsRail(): Promise<void> {
  const host = document.getElementById("toolbar-teams");
  if (!host) return;
  try {
    teams = await fetchTeams();
  } catch {
    // Sidecar may still be booting — loadInitialData() re-renders once it's up.
    // For a remote connection this is the sleeping-place state: show the server
    // chip anyway so the user can flip back to a reachable place.
    host.innerHTML = "";
    if (getConnections().length > 1) host.appendChild(buildServerChip(true));
    return;
  }
  host.innerHTML = "";
  // Server chip: which host this rail's teams belong to. Only shown once a
  // second connection exists — single-server users never see it.
  if (getConnections().length > 1) host.appendChild(buildServerChip(false));
  // Cross-host flip: the remembered team may not exist on this host — fall back
  // to the first team the server offers so channels don't query a ghost namespace.
  let active = getActiveTeam();
  if (teams.length && !teams.some((t) => (t.slug || t.name) === active)) {
    active = teams[0].slug || teams[0].name;
    setActiveTeam(active);
  }
  for (const t of teams) {
    const slug = t.slug || t.name;
    const btn = document.createElement("button");
    btn.className = "icon-btn header-btn team-btn" + (slug === active ? " active" : "");
    btn.textContent = (t.name || "?")[0].toUpperCase();
    btn.title = t.name;
    btn.addEventListener("click", () => switchTeam(slug));
    host.appendChild(btn);
  }
  const add = document.createElement("button");
  add.className = "icon-btn header-btn team-btn team-add";
  add.textContent = "+";
  add.title = "New team…";
  add.addEventListener("click", () => {
    const r = add.getBoundingClientRect();
    showNewTeamPopover(r.left, r.bottom + 4);
  });
  host.appendChild(add);
}

function switchTeam(slug: string): void {
  if (slug === getActiveTeam()) return;
  setActiveTeam(slug);
  // The whole workspace scopes to the team; a reload swaps it cleanly
  // (dockview layout and theme persist in localStorage).
  window.location.reload();
}

/** The active server's chip at the head of the teams rail. Click → connection
 *  menu. Flipping connections reloads, same as flipping teams (VS Code reloads
 *  the window on remote connect — same precedent, same reason). */
function buildServerChip(unreachable: boolean): HTMLElement {
  const conn = getActiveConnection();
  const chip = document.createElement("button");
  chip.className = "icon-btn header-btn server-chip" + (unreachable ? " unreachable" : "");
  chip.textContent = conn.id === "local" ? "⌂" : (conn.name || "?")[0].toUpperCase();
  chip.title = unreachable
    ? `${conn.name} — unreachable`
    : `Server: ${conn.name} (${conn.url})`;
  chip.addEventListener("click", () => {
    const r = chip.getBoundingClientRect();
    showServerMenu(r.left, r.bottom + 4);
  });
  return chip;
}

function showServerMenu(x: number, y: number): void {
  document.getElementById("server-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "server-menu";
  menu.className = "context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const active = getActiveConnection();
  for (const c of getConnections()) {
    const row = document.createElement("div");
    row.className = "context-menu-item" + (c.id === active.id ? " active" : "");
    row.textContent = `${c.id === active.id ? "✓ " : ""}${c.name}`;
    row.title = c.url;
    row.addEventListener("click", () => {
      menu.remove();
      if (c.id === active.id) return;
      setActiveConnectionId(c.id);
      window.location.reload();
    });
    menu.appendChild(row);
  }
  const manage = document.createElement("div");
  manage.className = "context-menu-item";
  manage.textContent = "Manage servers…";
  manage.addEventListener("click", () => {
    menu.remove();
    openSettings();
  });
  menu.appendChild(manage);
  document.body.appendChild(menu);
  const dismiss = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

function slugifyTeamName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function showNewTeamPopover(x: number, y: number): void {
  document.getElementById("team-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "team-menu";
  menu.className = "ctx-menu";
  const label = document.createElement("div");
  label.className = "ctx-menu-label";
  label.textContent = "New team";
  menu.appendChild(label);
  menu.appendChild(buildNewTeamRow(menu));
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + "px";
  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

function buildNewTeamRow(menu: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "team-new-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Team name";
  input.className = "team-new-input";
  const go = document.createElement("button");
  go.textContent = "Create";
  go.className = "team-new-create";
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await createTeam(name, slugifyTeamName(name));
      menu.remove();
      switchTeam(slugifyTeamName(name));
    } catch (e) {
      input.style.borderColor = "#f7768e";
      console.error("create team failed", e);
    }
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
  row.appendChild(input);
  row.appendChild(go);
  setTimeout(() => input.focus(), 0);
  return row;
}

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

function toggleTerminalPanel() {
  setTerminalOpen(!isTerminalOpen());
}

function setTerminalOpen(open: boolean) {
  const panel = document.getElementById("terminal-panel");
  const host = document.getElementById("terminal-host");
  const btn = document.getElementById("terminal-toggle-btn");
  // The chat now lives in a dockview panel, so the terminal takes over by hiding
  // the whole dock (instead of the individual chat elements). A later step makes
  // the terminal a dockable panel of its own, so it can sit beside chat.
  const dock = document.getElementById("dockview-container");
  if (!panel || !host) return;
  if (open && currentChannel) {
    if (dock) dock.style.display = "none";
    panel.style.display = "flex";
    btn?.classList.add("active");
    openTerminal(host, currentChannel.id);
    setTimeout(fitToGrid, 60);
  } else {
    panel.style.display = "none";
    if (dock) dock.style.display = "";
    btn?.classList.remove("active");
    closeTerminal();
  }
}

function renderOnboarding() {
  clearMessages();
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
  btn.addEventListener("click", () => openSettings(() => loadInitialData()));
  content.appendChild(btn);
  wrap.appendChild(content);
  messagesEl.appendChild(wrap);
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
  addBtn.addEventListener("click", () => openSettings(() => loadInitialData(), { tab: "agents", agentId: "new" }));
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
  settingsBtn.addEventListener("click", () => openSettings(() => loadInitialData(), { tab: "agents", agentId: agent.id }));
  agentInfoEl.appendChild(settingsBtn);

  // Model selector button (flat text + chevron, opens dropdown)
  // In a channel, a per-channel override (if set) takes effect instead of the agent default.
  const effectiveModel = (currentChannel && channelModelOverride) || agent.model;
  const modelBtn = document.createElement("button");
  modelBtn.className = "agent-model-btn";
  const displayName = getModelDisplayName(effectiveModel);
  const effortHtml = agent.effort ? `<span class="effort-badge">${escapeHtml(agent.effort)}</span>` : "";
  modelBtn.innerHTML = `<span class="model-label">${escapeHtml(displayName)}</span>${effortHtml}<svg class="model-chevron" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>`;
  if (models.length > 1 || agent.backend === "claude-cli") {
    modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showModelMenu(e, agent, models, effectiveModel);
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

function showModelMenu(event: MouseEvent, agent: Agent, models: BackendModel[], effectiveModel: string) {
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
    await updateAgent(agent.id, { effort: effort || null } as Partial<Agent>, chatScope);
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
    if (prev === "stopped") await clearInterrupt(agent.id, chatScope);
    if (prev === "safe") await setSafeMode(agent.id, false, chatScope);

    // Enable/disable transitions
    const wasEnabled = prev !== "disabled";
    const willEnable = state !== "disabled";
    if (!wasEnabled && willEnable) {
      await setHeartbeatEnabled(agent.id, true, chatScope);
      agent.heartbeat_enabled = true;
    } else if (wasEnabled && !willEnable) {
      await setHeartbeatEnabled(agent.id, false, chatScope);
      agent.heartbeat_enabled = false;
    }

    // Set up new state
    if (state === "safe") await setSafeMode(agent.id, true, chatScope);
    if (state === "stopped") await setInterrupt(agent.id, "User paused from desktop app", chatScope);

    agentThrottles[agent.id] = state;
  } catch (err) {
    console.error("Failed to set throttle:", err);
  }
  renderAgentTabs();
  renderAgentInfo();
}

async function changeModel(agent: Agent, model: string) {
  // In a channel: set a per-(channel, agent) override (persists for THIS channel only).
  // Picking the agent's default clears the override. Outside a channel: change the
  // agent's default model (all channels without an override follow it).
  try {
    if (currentChannel) {
      const clearing = model === agent.model;
      await setChannelModelOverride(currentChannel.id, agent.id, clearing ? "" : model, chatScope);
      channelModelOverride = clearing ? null : model;
    } else {
      await updateAgent(agent.id, { model }, chatScope);
      agent.model = model;
    }
    renderAgentInfo();
  } catch (err) {
    console.error("Failed to change model:", err);
  }
}

async function loadChannelModelOverride(channelId: string, agentId: string) {
  try {
    channelModelOverride = await getChannelModelOverride(channelId, agentId, chatScope);
  } catch {
    channelModelOverride = null;
  }
}

async function loadAgentThrottle(agent: Agent) {
  if (!agent.heartbeat_enabled) {
    agentThrottles[agent.id] = "disabled";
    return;
  }
  try {
    const [safeResp, intResp] = await Promise.all([
      getSafeMode(agent.id, chatScope),
      getInterrupt(agent.id, chatScope),
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

  if (currentChannel) {
    try {
      await setChannelAgent(currentChannel.id, agent.id, chatScope);
    } catch {
      // Non-critical
    }
    await loadChannelModelOverride(currentChannel.id, agent.id);
  } else {
    channelModelOverride = null;
  }

  renderAgentTabs();
  renderAgentInfo();
}

async function loadChannelAgent(channelId: string) {
  channelModelOverride = null;
  try {
    const config = await getChannelConfig(channelId, chatScope);
    const agentId = config.agent_id as string | null;
    if (agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) {
        currentAgent = agent;
        localStorage.setItem("lit-desktop-agent", agent.id);
        await loadChannelModelOverride(channelId, agent.id);
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
  }
  if (currentAgent) {
    await loadChannelModelOverride(channelId, currentAgent.id);
  }
  renderAgentTabs();
  renderAgentInfo();
}

// --- Folder opening ---

async function handleOpenFolder() {
  const selected = await open({ directory: true, title: "Open project folder" });
  if (!selected) return;

  const folderPath = typeof selected === "string" ? selected : selected;
  try {
    const result = await openFolder(folderPath, undefined, chatScope);
    const newChannel: Channel = {
      id: result.id || result.name,
      name: result.name,
      unreadCount: 0,
    };
    if (!localChannels.find((c) => c.id === newChannel.id)) {
      localChannels.push(newChannel);
      saveLocalChannels();
    }
    renderSidebar(mergeChannels(localChannels, await fetchChannels(chatScope)));
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

async function archiveCurrentChannel() {
  if (!currentChannel) return;
  const archived = currentChannel;
  // Archive is PATCH /channels/{id} (folder channels: removes the symlink so it
  // drops from navigation). Await it before refreshing, or the refresh races the
  // archive and the channel reappears.
  try {
    await fetch(`${chatScope.connection.url}/mux/channels/${archived.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(chatScope.connection) },
      body: JSON.stringify({ team: chatScope.team }),
    });
  } catch { /* offline / already gone */ }

  localChannels = localChannels.filter((c) => c.id !== archived.id);
  saveLocalChannels();
  localStorage.removeItem("lit-desktop-channel");
  currentChannel = null;
  channelTitle.textContent = "Welcome";
  channelActionsEl.innerHTML = "";
  clearMessages();
  if (channelWs) { channelWs.close(); channelWs = null; }
  await refreshSidebar();
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
  // If the terminal is open, re-attach it to the newly-opened channel.
  if (isTerminalOpen()) {
    const host = document.getElementById("terminal-host");
    if (host) { openTerminal(host, channel.id); setTimeout(fitToGrid, 60); }
  }
  clearMessages();

  if (channelWs) {
    channelWs.close();
    channelWs = null;
  }

  await loadChannelAgent(channel.id);

  try {
    const messages = await fetchChannelMessages(channel.id, 50, chatScope);

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

    // Non-fatal: a mark-read failure must not masquerade as a load failure.
    markChannelRead(channel.id, chatScope).catch(() => {});
    connectWebSocket(channel.id);
  } catch (err) {
    renderMessage({ role: "system", content: `Failed to load messages: ${err}` });
  }

  refreshSidebar();
  messageInput.focus();
}

// --- WebSocket ---

function connectWebSocket(channelId: string) {
  channelWs = createChannelWebSocket(channelId, chatScope);

  channelWs.onopen = () => {
    wsReconnectAttempt = 0;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    showConnectionStatus("connected");
  };

  channelWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Suppress an outbound (assistant) message that lands right after
      // stream_end — the live stream already rendered its content. Matches the
      // webapp's 5s window. Only active when the stream actually had content, so
      // a failed/empty stream never hides the authoritative persisted message.
      const suppressAfterStream = (direction?: string) =>
        direction !== "in" && lastStreamEndTime > 0 && Date.now() - lastStreamEndTime < 5000;

      if (data.type === "new_messages" && Array.isArray(data.messages)) {
        let added = false;
        for (const msg of data.messages) {
          if (knownMessageIds.has(msg.id)) continue;
          knownMessageIds.add(msg.id);
          if (suppressAfterStream(msg.direction)) continue;
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
          markChannelRead(channelId, chatScope).catch(() => {});
        }
      } else if (data.id && data.content && data.direction) {
        if (!knownMessageIds.has(data.id)) {
          knownMessageIds.add(data.id);
          if (!suppressAfterStream(data.direction)) {
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
          }
          if (document.visibilityState === "visible") {
            markChannelRead(channelId, chatScope).catch(() => {});
          }
        }
      } else if (data.type === "thinking") {
        // Agent is connecting — show the streaming bubble early so a missed
        // stream_start never causes the first content frames to be dropped.
        if (!streamingEl) showTypingIndicator();
      } else if (data.type === "stream_start") {
        streamingChannels.add(channelId);
        activeStreamId = data.stream_id || null;
        renderSidebarIndicators();
        showTypingIndicator();
        cancelStreamBtn.style.display = "";
      } else if (data.type === "stream_chunk" && data.content) {
        appendStreamToken(data.content);
      } else if (data.type === "stream_replace") {
        // Full content each frame (JSONL-sourced bridge + replay). Previously
        // ignored by the desktop, so those frames never rendered live.
        setStreamContent(data.content || "");
      } else if (data.type === "stream_end") {
        streamingChannels.delete(channelId);
        activeStreamId = null;
        renderSidebarIndicators();
        // Prefer the authoritative content carried on stream_end (JSONL-sourced)
        // over the accumulated chunks — this recovers the full response even if
        // some live chunks were missed in transit.
        if (typeof data.content === "string" && data.content) {
          setStreamContent(data.content);
        }
        const hadContent = !!streamingText.trim();
        finalizeStream();
        lastStreamEndTime = hadContent ? Date.now() : 0;
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
    markChannelRead(currentChannel.id, chatScope).catch(() => {});
    if (channelWs?.readyState !== WebSocket.OPEN) {
      connectWebSocket(currentChannel.id);
    }
  }
});

// --- Streaming ---

let streamingEl: HTMLElement | null = null;
let streamingText = "";
// Timestamp of the last stream_end that carried content — used to suppress the
// duplicate persisted assistant message that arrives just after (webapp parity).
let lastStreamEndTime = 0;

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

// stream_chunk carries a delta (append); stream_replace carries the full
// content each frame (the JSONL-sourced bridge emits these). The webapp's
// channel view handles both — the desktop previously only handled append,
// so replace frames rendered nothing live.
function appendStreamToken(token: string) {
  streamingText += token;
  renderStreamingText();
}

function setStreamContent(full: string) {
  streamingText = full;
  renderStreamingText();
}

function renderStreamingText() {
  if (!streamingEl) showTypingIndicator();

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
    await fetch(`${chatScope.connection.url}/mux/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
      headers: authHeaders(chatScope.connection),
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
        const result = await uploadImage(file, currentChannel.id, chatScope);
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
    await postChannelMessage(currentChannel.id, content, chatScope);
  } catch (err) {
    renderMessage({ role: "system", content: `Failed to send: ${err}` });
  }
}

// --- Refresh ---

async function refreshSidebar() {
  try {
    const remote = await fetchChannels(chatScope);
    channelListCache = remote;
    renderSidebar(mergeChannels(localChannels, remote));
  } catch {
    // Not critical
  }
}

async function refreshAgents() {
  try {
    agents = await fetchAgents(chatScope);
    // Refresh throttle state for current agent
    if (currentAgent) {
      await loadAgentThrottle(currentAgent);
    }
    // Refresh usage for current agent's backend
    if (currentAgent) {
      try {
        usageReports[currentAgent.backend] = await fetchUsage(currentAgent.backend, chatScope);
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
      wm.setTheme(next);
    });
  }
}

async function init() {
  document.title = brand.windowTitle;
  initTheme();
  setStatus("connecting");
  initSidebar();
  renderTeamsRail();
  setupDock();
  setupAppToolbar();

  const scrollBtn = document.getElementById("scroll-to-bottom");
  if (scrollBtn) scrollBtn.addEventListener("click", scrollToBottom);

  const settingsBtn = document.getElementById("settings-btn-global");
  if (settingsBtn) settingsBtn.addEventListener("click", () => openSettings(() => loadInitialData()));

  const searchBtn = document.getElementById("search-toggle-btn");
  if (searchBtn) searchBtn.addEventListener("click", openSearch);

  const terminalBtn = document.getElementById("terminal-toggle-btn");
  if (terminalBtn) terminalBtn.addEventListener("click", toggleTerminalPanel);
  const terminalClose = document.getElementById("terminal-drawer-close");
  if (terminalClose) terminalClose.addEventListener("click", () => setTerminalOpen(false));
  window.addEventListener("resize", () => { if (isTerminalOpen()) fitToGrid(); });

  renderMessage({
    role: "system",
    content: "Starting LIT backend...",
  });
  const connected = await startBackend();
  if (!connected) {
    setStatus("disconnected");
    clearMessages();
    const logPath = await backendLogPath();
    renderMessage({
      role: "system",
      content:
        "**Failed to start the LIT backend.**\n\n" +
        (backendStartError ? backendStartError + "\n\n" : "") +
        "The full startup log (including any error) was written to:\n\n" +
        "`" + logPath + "`",
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
  clearMessages();

  setStatus("connected");
  await loadInitialData();
}

async function loadInitialData() {
  // The boot-time render races sidecar startup; re-render now that it's up.
  renderTeamsRail();
  try {
    // Fetch agents, models, channels, and team apps in parallel
    const [agentsData, modelsData, remote, appsData] = await Promise.all([
      fetchAgents(chatScope),
      fetchModels(chatScope).catch(() => ({})),
      fetchChannels(chatScope),
      fetchApps(chatScope).catch(() => []),
    ]);

    agents = agentsData;
    backendModels = modelsData;
    appsCache = appsData;

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
            usageReports[b] = await fetchUsage(b, chatScope);
          } catch {
            // Usage may not be available for all backends
          }
        })
      );
    }

    renderAgentTabs();
    renderAgentInfo();

    channelListCache = remote;
    // Reconcile: drop local channels the server no longer recognizes (stale
    // cross-backend ghosts). Open-Folder registers server-side and appears in
    // navigation, so real channels survive; only ghosts (which 404 on send) go.
    const remoteIds = new Set(remote.map((c) => c.id));
    const ghosts = localChannels.filter((c) => !remoteIds.has(c.id));
    if (ghosts.length) {
      localChannels = localChannels.filter((c) => remoteIds.has(c.id));
      saveLocalChannels();
      console.log("[channels] pruned stale local channels:", ghosts.map((c) => c.id));
    }
    const all = mergeChannels(localChannels, remote);
    renderSidebar(all);

    if (agents.length === 0) {
      renderOnboarding();
      return;
    }

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
    { id: "open-file", label: "Open File…", icon: "📄", shortcut: "Ctrl+O", action: handleOpenFile },
    { id: "search-channel", label: "Search in Channel…", icon: "🔍", shortcut: "Ctrl+F", action: openSearch },
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

  for (const t of teams) {
    const slug = t.slug || t.name;
    if (slug === getActiveTeam()) continue;
    cmds.push({ id: `team-${slug}`, label: `Switch to team: ${t.name}`, icon: "⊞", action: () => switchTeam(slug) });
  }

  for (const app of appsCache) {
    cmds.push({ id: `app-${app.id}`, label: `Open app: ${app.title}`, icon: "🧩", action: () => openApp(app) });
  }

  return cmds;
}

let channelListCache: Channel[] = [];
let appsCache: AppWidget[] = [];
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
    const pinned = isFavorite(cmd.id);
    item.innerHTML = `<span class="cmd-icon">${cmd.icon}</span><span class="cmd-label">${escapeHtml(cmd.label)}</span>${cmd.shortcut ? `<span class="cmd-shortcut">${cmd.shortcut}</span>` : ""}<span class="cmd-pin${pinned ? " pinned" : ""}" title="${pinned ? "Unpin from toolbar" : "Pin to toolbar"}">${pinned ? "★" : "☆"}</span>`;
    item.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("cmd-pin")) {
        // Toggle pin without running the command or closing the palette.
        e.stopPropagation();
        toggleFavorite(cmd.id);
        const nowPinned = t.classList.toggle("pinned");
        t.textContent = nowPinned ? "★" : "☆";
        t.title = nowPinned ? "Unpin from toolbar" : "Pin to toolbar";
        return;
      }
      closeCommandPalette();
      cmd.action();
    });
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
      await cancelStream(activeStreamId, chatScope);
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
  // VS Code muscle memory: Ctrl/Cmd+Shift+P and F1 also open the command palette.
  if (
    ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") ||
    e.key === "F1"
  ) {
    e.preventDefault();
    openCommandPalette();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    sidebarOpen ? collapseSidebar() : expandSidebar();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    handleOpenFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
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

window.addEventListener("beforeunload", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});

init();
