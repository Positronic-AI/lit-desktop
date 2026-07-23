import {
  checkConnection,
  fetchCalendarDates,
  fetchCalendarDay,
  fetchMessageContent,
  type CalendarDayMessage,
  fetchApps,
  type AppWidget,
  readServerFile,
  writeServerFile,
  searchChannelMessages,
  fetchTeams,
  createTeam,
  getConnections,
  getActiveConnection,
  activeScope,
  type Scope,
  type TeamInfo,
} from "./api";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { Command as ShellCommand, type Child } from "@tauri-apps/plugin-shell";
import { renderMarkdown } from "./markdown";
import { openSettings, registerSettingsOpener, mountSettingsPanel, disposeSettingsPanel } from "./settings";
import { openTerminal, closeTerminal, isTerminalOpen, fitToGrid } from "./terminal";
import { brand } from "./brand";
import { WindowManager } from "./window-manager";
import { registerPanel } from "./panel-host";
import { mountGraphView } from "./graph-view";
import { ChatPanel, escapeHtml } from "./chat-panel";
import "dockview-core/dist/styles/dockview.css";

// --- Docking shell (Step 1: chat becomes a dockview panel) ---
const wm = new WindowManager();
const DOCK_LAYOUT_KEY = "lit-desktop-dock-layout";

// All live chat panels by dockview panel id, plus which one the user last
// touched. Shell surfaces (search, calendar, terminal, palette, shortcuts) act
// on the focused panel, so they follow you between places. There is no special
// primary panel — every chat view is a place tab; setupDock guarantees at
// least one exists before anything calls activeChat().
const chatPanels = new Map<string, ChatPanel>();
let focusedChat: ChatPanel | null = null;
// Gates mount-time data loads: tabs created before the backend is up are
// loaded by init()'s loadInitialData() instead, so boot doesn't flash errors.
let bootComplete = false;

function activeChat(): ChatPanel {
  if (focusedChat) return focusedChat;
  const first = chatPanels.values().next();
  if (first.done) throw new Error("no chat panel mounted");
  return first.value;
}

// External http(s) links anywhere in the app open in the system browser —
// clicking one must never navigate the webview away from the app. Capture
// phase so no inner handler (or the default navigation) runs first. When an
// in-app browser exists it takes over here.
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(href))
      .catch(() => window.open(href, "_blank"));
  },
  { capture: true },
);

/** Hooks every chat panel needs into app-level surfaces. */
function wireChatHooks(p: ChatPanel): void {
  p.onOpenSearch = openSearch;
  p.onToggleTerminal = toggleTerminalPanel;
  p.onReload = () => loadInitialData();
  p.onImageClick = openLightbox;
  // A path clicked in a message opens on the machine that message lives on —
  // the panel's own scope, not whichever place happens to be focused.
  p.onOpenFile = (path) => openViewer(path, p.scope);
}

// A chat tab: its own ChatPanel standing in (connectionId, team) — possibly a
// different team on a different server than its neighbors. Params persist in
// the dockview layout, so tabs restore across restarts; missing params (the
// legacy "chat" anchor panel) or a since-removed connection fall back to the
// active scope.
function chatPanelMount(fixedId?: string) {
  let p: ChatPanel | null = null;
  let panelId = "";
  return {
    mount(host: HTMLElement, params: Record<string, any>) {
      panelId = fixedId ?? String(params.id || `chat:${params.connectionId}:${params.team}`);
      const conn = params.connectionId
        ? getConnections().find((c) => c.id === params.connectionId)
        : undefined;
      const scope = conn
        ? { connection: conn, team: String(params.team || "local") }
        : activeScope();
      p = new ChatPanel(scope);
      wireChatHooks(p);
      chatPanels.set(panelId, p);
      if (!focusedChat) focusedChat = p;
      p.mount(host);
      host.addEventListener("pointerdown", () => { if (p) focusedChat = p; }, true);
      if (bootComplete) void p.loadInitialData();
    },
    dispose() {
      p?.dispose();
      chatPanels.delete(panelId);
      if (p && focusedChat === p) focusedChat = null;
      p = null;
    },
  };
}

registerPanel("chat", () => chatPanelMount("chat")); // legacy saved layouts
registerPanel("chat-tab", () => chatPanelMount());

// Settings is a dock tab like everything else — one container paradigm.
registerPanel("settings", () => ({
  mount(host: HTMLElement) {
    mountSettingsPanel(host);
  },
  dispose() {
    disposeSettingsPanel();
  },
}));
registerSettingsOpener(() => {
  if (!wm.hasPanel("settings")) {
    wm.addPanel({ id: "settings", component: "settings", title: "Settings" });
  }
  wm.focusPanel("settings");
});

/** Focus-or-open a chat tab standing in (connectionId, team). One tab per
 *  place via the panel id (focus-or-open); open the same place twice via the
 *  palette? The existing tab focuses — side-by-side same-team views can still
 *  be arranged by dragging a second place's tab next to it. */
function openChatTab(connectionId: string, team: string): void {
  const id = `chat:${connectionId}:${team}`;
  if (!wm.hasPanel(id)) {
    const conn = getConnections().find((c) => c.id === connectionId);
    const server = !conn || conn.id === "local" ? "⌂" : conn.name;
    wm.addPanel({
      id,
      component: "chat-tab",
      title: `${team} · ${server}`,
      persistent: true,
      params: { id, connectionId, team },
    });
  }
  wm.focusPanel(id);
}

// The viewer panel renders a file's text beside the chat — markdown rendered,
// other files syntax-highlighted in a code block, with a plain-text edit mode
// saved back through the same scope the file was opened from. A Monaco
// editor/diff comes later.
registerPanel("viewer", () => ({
  mount(host: HTMLElement, params: Record<string, any>) {
    const path = String(params.path || "");
    // Resolve the scope the panel was opened with (survives layout restore via
    // params). A vanished connection falls back to the active scope.
    const conn = getConnections().find((c) => c.id === params.connectionId);
    const scope: Scope = conn ? { connection: conn, team: String(params.team || "everyone") } : activeScope();

    const toolbar = document.createElement("div");
    toolbar.className = "viewer-toolbar";
    const pathLabel = document.createElement("span");
    pathLabel.className = "viewer-path";
    pathLabel.textContent = conn && conn.id !== "local" ? `${conn.name}:${path}` : path;
    const editBtn = document.createElement("button");
    editBtn.className = "viewer-btn";
    editBtn.textContent = "Edit";
    toolbar.append(pathLabel, editBtn);

    const body = document.createElement("div");
    body.className = "viewer-body";
    body.textContent = `Loading ${path}…`;
    host.append(toolbar, body);

    let raw = "";
    const renderView = () => {
      const isMd = /\.(md|markdown)$/i.test(path);
      const ext = (path.split(".").pop() || "").toLowerCase();
      body.innerHTML = renderMarkdown(isMd ? raw : "```" + ext + "\n" + raw + "\n```");
    };

    const enterEdit = () => {
      const ta = document.createElement("textarea");
      ta.className = "viewer-edit";
      ta.value = raw;
      ta.spellcheck = false;
      const save = async () => {
        try {
          await writeServerFile(path, ta.value, scope);
          raw = ta.value;
          exitEdit();
        } catch (e: any) {
          pathLabel.textContent = `Save failed: ${e?.message || e}`;
        }
      };
      const exitEdit = () => {
        editBtn.textContent = "Edit";
        editBtn.onclick = enterEdit;
        renderView();
      };
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          void save();
        }
      });
      editBtn.textContent = "Save";
      editBtn.onclick = () => void save();
      body.replaceChildren(ta);
      ta.focus();
    };
    editBtn.onclick = enterEdit;

    readServerFile(path, scope)
      .then((content) => {
        raw = content;
        renderView();
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
registerPanel("app", () => {
  let onMessage: ((ev: MessageEvent) => void) | null = null;
  let themeObserver: MutationObserver | null = null;
  return {
    mount(host: HTMLElement, params: Record<string, any>) {
      const url = String(params.url || "");
      if (!url) {
        host.textContent = "This app has no URL to open.";
        return;
      }
      const iframe = document.createElement("iframe");
      iframe.className = "app-panel-iframe";
      iframe.src = url.startsWith("http") ? url : `${activeChat().scope.connection.url}${url}`;
      host.appendChild(iframe);

      // Hosted apps follow the app theme, and their window.open (swallowed by
      // webviews) is forwarded as a lit-open-url message → system browser.
      // Connector apps rely on this for their OAuth flows.
      const postTheme = () => {
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        iframe.contentWindow?.postMessage({ type: "lit-theme", theme }, "*");
      };
      iframe.addEventListener("load", postTheme);
      themeObserver = new MutationObserver(postTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      onMessage = (ev: MessageEvent) => {
        if (ev.source === iframe.contentWindow && ev.data?.type === "lit-open-url") {
          import("@tauri-apps/plugin-opener")
            .then((m) => m.openUrl(ev.data.url))
            .catch(() => window.open(ev.data.url, "_blank"));
        }
      };
      window.addEventListener("message", onMessage);
    },
    dispose() {
      if (onMessage) window.removeEventListener("message", onMessage);
      themeObserver?.disconnect();
    },
  };
});

/** Open (or focus) a team app in its own panel. */
function openApp(app: AppWidget): void {
  if (app.type !== "iframe" || !app.url) {
    activeChat().renderMessage({ role: "system", content: `"${app.title}" isn't a supported app type in the desktop yet.` });
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
        if (name === "graph" && !graphLoaded && activeChat().currentChannel) {
          const cp = activeChat();
          graphLoaded = true;
          graphDispose = mountGraphView(bodyFor("graph"), {
            channelId: cp.currentChannel!.id,
            jumpToMessage: (id?: string) => { void cp.jumpToMessage(id); },
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
        const cp = activeChat();
        const channel = cp.currentChannel;
        if (!channel) { status.textContent = "Open a channel to search."; return; }
        status.textContent = "Searching…";
        try {
          const results = await searchChannelMessages(channel.id, q, regexCb.checked, cp.scope);
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
            row.addEventListener("click", () => { void cp.jumpToMessage(r.message_id); });
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
  const cp = activeChat();
  const channel = cp.currentChannel;
  if (!channel) { host.innerHTML = `<div class="search-placeholder">Open a channel first.</div>`; return; }
  const channelId = channel.id;
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
      r.addEventListener("click", () => { void cp.jumpToMessage((r as HTMLElement).dataset.id); }));
    dayObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        dayObserver!.unobserve(el);
        const pv = el.querySelector("[data-preview]") as HTMLElement;
        fetchMessageContent(el.dataset.ref!, cp.scope).then((raw) => { if (raw) pv.textContent = messagePreview(raw); }).catch(() => {});
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
    try { dayMessages = await fetchCalendarDay(channelId, date, cp.scope); }
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

  fetchCalendarDates(channelId, cp.scope).then((d) => {
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
  // Legacy-anchor cleanup: older layouts carried a scope-less "Chat" panel.
  // Once real place tabs exist it's a redundant third view — drop it so a
  // restart doesn't grow an extra tab. Alone, it stays (it IS the place tab).
  if (restored && wm.hasPanel("chat") && [...chatPanels.keys()].some((id) => id !== "chat")) {
    wm.removePanel("chat");
  } else if (wm.hasPanel("chat")) {
    // A surviving legacy anchor IS the active place's tab — title it as one
    // (no view without a visible address).
    const s = activeScope();
    const panel = wm.api?.getPanel("chat") as any;
    panel?.setTitle?.(`${s.team} · ${s.connection.id === "local" ? "⌂" : s.connection.name}`);
  }
  // Fresh boot (no layout): one tab standing in the active place.
  if (chatPanels.size === 0) {
    const s = activeScope();
    openChatTab(s.connection.id, s.team);
  }
  // Focus follows the active dockview panel when it's a chat panel; panels that
  // aren't chat (search, viewer, apps) leave the last chat focus in place.
  wm.api?.onDidActivePanelChange((e) => {
    const p = e?.id ? chatPanels.get(e.id) : undefined;
    if (p) focusedChat = p;
  });
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

/** Open a file in a viewer panel beside the chat (focus it if already open).
 *  The scope pins which machine the path lives on; the same path on two
 *  servers is two distinct panels. */
function openViewer(path: string, scope: Scope = activeScope()): void {
  const id = `viewer:${scope.connection.id}:${path}`;
  if (wm.hasPanel(id)) {
    wm.focusPanel(id);
    return;
  }
  const name = path.split("/").pop() || path;
  const title = scope.connection.id === "local" ? name : `${name} · ${scope.connection.name}`;
  wm.addPanel({
    id,
    component: "viewer",
    title,
    params: { path, connectionId: scope.connection.id, team: scope.team },
  });
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

// --- Places catalog ---
// Team lists per connection — the catalog of PLACES you can open a chat tab
// into (or star). Loaded in loadInitialData for every signed-in/no-auth
// connection. (The old teams rail is retired: switching teams = opening a
// place tab; its jobs live in the command palette now.)
const teamsByConn = new Map<string, TeamInfo[]>();

function refreshPlaceCatalog(): void {
  for (const c of getConnections()) {
    if (c.auth === "keycloak" && !c.refreshToken) continue; // not signed in
    fetchTeams({ connection: c, team: "local" })
      .then((list) => {
        teamsByConn.set(c.id, list);
        // Pinned place shortcuts resolve against the command list — re-render
        // the rail now that this connection's places exist, or boot-time pins
        // silently drop until the next manual re-star.
        renderToolbarFavorites();
      })
      .catch(() => { /* unreachable place — keep any previous list */ });
  }
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
      // A new team is a new place: refresh the catalog and stand in it.
      refreshPlaceCatalog();
      openChatTab(getActiveConnection().id, slugifyTeamName(name));
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

function setStatus(_state: "connected" | "disconnected" | "connecting") {
  // Connection state tracked internally; no visible status bar
}

// --- Terminal overlay ---

function toggleTerminalPanel() {
  setTerminalOpen(!isTerminalOpen());
}

function setTerminalOpen(open: boolean) {
  const panel = document.getElementById("terminal-panel");
  const host = document.getElementById("terminal-host");
  // The chat now lives in a dockview panel, so the terminal takes over by hiding
  // the whole dock (instead of the individual chat elements). A later step makes
  // the terminal a dockable panel of its own, so it can sit beside chat.
  const dock = document.getElementById("dockview-container");
  if (!panel || !host) return;
  const cp = activeChat();
  if (open && cp.currentChannel) {
    if (dock) dock.style.display = "none";
    panel.style.display = "flex";
    cp.setTerminalButtonActive(true);
    openTerminal(host, cp.currentChannel.id);
    setTimeout(fitToGrid, 60);
  } else {
    panel.style.display = "none";
    if (dock) dock.style.display = "";
    cp.setTerminalButtonActive(false);
    closeTerminal();
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
  setupDock();
  setupAppToolbar();

  const settingsBtn = document.getElementById("settings-btn-global");
  if (settingsBtn) settingsBtn.addEventListener("click", () => openSettings(() => loadInitialData()));

  const terminalClose = document.getElementById("terminal-drawer-close");
  if (terminalClose) terminalClose.addEventListener("click", () => setTerminalOpen(false));
  window.addEventListener("resize", () => { if (isTerminalOpen()) fitToGrid(); });

  // Stamp the template's boot state with the real brand + version and a
  // truthful status line; the first real render replaces it wholesale.
  const version = await import("@tauri-apps/api/app")
    .then((m) => m.getVersion())
    .catch(() => "");
  document.querySelectorAll(".boot-brand-name").forEach((n) => (n.textContent = brand.displayName));
  document.querySelectorAll(".boot-version").forEach((n) => (n.textContent = version ? ` v${version}` : ""));
  document.querySelectorAll(".boot-text").forEach((n) => (n.textContent = "Starting the local backend…"));

  const connected = await startBackend();
  if (!connected) {
    setStatus("disconnected");
    activeChat().clearMessages();
    const logPath = await backendLogPath();
    activeChat().renderMessage({
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
        bootComplete = true;
        activeChat().clearMessages();
        await loadInitialData();
      } else {
        setStatus("disconnected");
      }
    }, 5000);
    return;
  }
  activeChat().clearMessages();

  setStatus("connected");
  bootComplete = true;
  await loadInitialData();
}

async function loadInitialData() {
  // The boot-time render races sidecar startup; re-render now that it's up.
  // Team apps for the command palette / app panels (non-critical).
  fetchApps(activeChat().scope)
    .then((apps) => { appsCache = apps; })
    .catch(() => { appsCache = []; });
  // Place catalog for "Open chat tab: …" commands and starred places.
  refreshPlaceCatalog();
  // Every open place tab (re)loads — restored tabs get their first real load
  // here, after the backend is up.
  await Promise.all([...chatPanels.values()].map((p) => p.loadInitialData()));
  // Channel/agent pins resolve against loaded data the same way place pins do.
  renderToolbarFavorites();
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
    { id: "open-folder", label: "Open Folder", icon: "📂", action: () => activeChat().handleOpenFolder() },
    { id: "open-file", label: "Open File…", icon: "📄", shortcut: "Ctrl+O", action: handleOpenFile },
    { id: "search-channel", label: "Search in Channel…", icon: "🔍", shortcut: "Ctrl+F", action: openSearch },
    { id: "toggle-sidebar", label: "Toggle Sidebar", icon: "◧", shortcut: "Ctrl+\\", action: () => activeChat().toggleSidebar() },
    { id: "toggle-theme", label: "Toggle Theme", icon: "☾", action: () => document.getElementById("theme-toggle")?.click() },
    { id: "scroll-bottom", label: "Scroll to Bottom", icon: "↓", action: () => activeChat().scrollToBottom() },
  ];

  for (const ch of activeChat().getChannels()) {
    cmds.push({ id: `ch-${ch.id}`, label: `Switch to #${ch.name}`, icon: "#", action: () => activeChat().openChannel(ch) });
  }

  for (const agent of activeChat().agents) {
    cmds.push({ id: `agent-${agent.id}`, label: `Select agent: ${agent.name}`, icon: "🤖", action: () => activeChat().selectAgent(agent) });
  }

  cmds.push({
    id: "new-team", label: "New Team…", icon: "⊞", action: () => {
      const r = document.getElementById("toolbar-add")?.getBoundingClientRect();
      showNewTeamPopover(r ? r.left : 100, r ? r.bottom + 4 : 100);
    },
  });
  cmds.push({ id: "manage-servers", label: "Manage Servers…", icon: "🌐", action: () => openSettings(() => loadInitialData()) });
  cmds.push({
    id: "reset-layout",
    label: "Reset Window Layout",
    icon: "🧹",
    action: () => {
      localStorage.removeItem(DOCK_LAYOUT_KEY);
      window.location.reload();
    },
  });

  // Places: open (or focus) a chat tab standing in a (server, team) — any team
  // on any connected server. Pinning one of these to the toolbar (the palette's
  // ☆) is exactly "starring a place": the pin becomes a sidebar shortcut whose
  // click is focus-or-open. Address model made chrome.
  for (const [connId, list] of teamsByConn) {
    const conn = getConnections().find((c) => c.id === connId);
    if (!conn) continue;
    const server = conn.id === "local" ? "⌂" : conn.name;
    for (const t of list) {
      const slug = t.slug || t.name;
      cmds.push({
        id: `place-${connId}-${slug}`,
        label: `Open chat tab: ${t.name} · ${server}`,
        icon: (t.name || "?")[0].toUpperCase(),
        action: () => openChatTab(connId, slug),
      });
    }
  }

  for (const app of appsCache) {
    cmds.push({ id: `app-${app.id}`, label: `Open app: ${app.title}`, icon: "🧩", action: () => openApp(app) });
  }

  return cmds;
}

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

// --- Global keyboard shortcuts ---

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
    activeChat().toggleSidebar();
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

/** Opened by the chat panel when a message image is clicked (onImageClick). */
function openLightbox(src: string) {
  lightboxImg.src = src;
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  lightboxImg.style.transform = "";
  lightboxEl.classList.add("active");
}

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

window.addEventListener("beforeunload", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});

init();
