// Shared browser panel — port of the webapp's browser-widget (lit-server
// browser-widget.component.ts) into the desktop's vanilla-DOM panel idiom.
// Plan: lit-platform docs/plans/desktop-shared-browser.md.
//
// The backend is the sidecar's /mux/browser/* surface (browser_service.py):
// one headless Chrome per user, CDP screencast frames over SSE, input events
// back over REST. The agent drives the SAME Chrome via the playwright MCP →
// /browser/cdp-proxy path — that's the "shared" in shared browser; this panel
// is only the human's half. Built on Scope so a future chat-tab param can
// point it at a remote place unchanged (phase 2).

import { registerPanel } from "./panel-host";
import { hostFetch, authHeaders, activeScope, type Scope } from "./api";
import { updateWidgetContext, removeWidgetContext } from "./widget-context";

interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

interface FramePayload {
  type: string;
  data: string;
  url?: string;
  title?: string;
  frame_count?: number;
  viewport_width?: number;
  viewport_height?: number;
  tabs?: TabInfo[];
}

const CSS = `
.bp-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-primary, #1a1b26); }
.bp-toolbar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; flex: none; }
.bp-nav-btn { width: 28px; height: 28px; border: none; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font-size: 14px; }
.bp-nav-btn:hover { background: var(--bg-hover, rgba(255,255,255,0.08)); }
.bp-url { flex: 1; padding: 6px 12px; border-radius: 14px; border: 1px solid var(--border-color, #333); background: var(--bg-secondary, rgba(0,0,0,0.2)); color: inherit; font-size: 12px; outline: none; }
.bp-url:focus { border-color: var(--accent-color, #7aa2f7); }
.bp-tabs { display: flex; gap: 2px; padding: 0 8px; flex: none; overflow-x: auto; scrollbar-width: none; }
.bp-tab { display: flex; align-items: center; gap: 6px; max-width: 180px; padding: 4px 8px; border-radius: 6px 6px 0 0; font-size: 11px; cursor: pointer; opacity: 0.6; white-space: nowrap; }
.bp-tab.active { opacity: 1; background: var(--bg-hover, rgba(255,255,255,0.08)); }
.bp-tab-title { overflow: hidden; text-overflow: ellipsis; }
.bp-tab-close { border: none; background: none; color: inherit; cursor: pointer; padding: 0 2px; font-size: 12px; opacity: 0.7; }
.bp-tab-close:hover { opacity: 1; }
.bp-viewport-container { flex: 1; min-height: 0; position: relative; outline: none; overflow: hidden; background: #000; }
.bp-viewport { display: block; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
.bp-status { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 24px; }
.bp-status .bp-msg { opacity: 0.8; max-width: 420px; }
.bp-status code { display: block; margin-top: 6px; padding: 8px 10px; border-radius: 6px; background: rgba(0,0,0,0.35); font-size: 12px; user-select: text; }
.bp-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid var(--border-color, #555); background: transparent; color: inherit; cursor: pointer; }
.bp-btn:hover { border-color: #888; }
.bp-spinner { width: 22px; height: 22px; border: 2px solid rgba(127,127,127,0.3); border-top-color: var(--accent-color, #7aa2f7); border-radius: 50%; animation: bp-spin 0.8s linear infinite; }
@keyframes bp-spin { to { transform: rotate(360deg); } }
.bp-offline { position: absolute; top: 8px; right: 8px; font-size: 11px; padding: 2px 8px; border-radius: 9px; background: rgba(200,60,60,0.85); color: #fff; }
`;

class BrowserPanel {
  private scope: Scope;
  private sessionId: string;
  private initialUrl: string;

  private host: HTMLElement | null = null;
  private viewportImg: HTMLImageElement | null = null;
  private viewportContainer: HTMLDivElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private offlineEl: HTMLElement | null = null;

  private currentUrl = "";
  private viewportWidth = 1280;
  private viewportHeight = 720;
  private tabs: TabInfo[] = [];

  private abort: AbortController | null = null;
  private frameUrl: string | null = null;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  private mousemoveThrottle: ReturnType<typeof setTimeout> | null = null;
  private scrollThrottle: ReturnType<typeof setTimeout> | null = null;
  private mouseIsDown = false;
  private dragStartPos: { x: number; y: number } | null = null;
  private hasDragged = false;

  constructor(params: Record<string, any>) {
    this.scope = params.scope || activeScope();
    this.sessionId = params.sessionId || "default";
    this.initialUrl = params.initialUrl || "";
  }

  // ---- API plumbing ----

  private async api(path: string, method = "POST", body?: unknown): Promise<any> {
    const res = await hostFetch(`${this.scope.connection.url}/mux/browser${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders(this.scope.connection) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    return data;
  }

  private session(path: string, method = "POST", body?: unknown): Promise<any> {
    return this.api(`/sessions/${this.sessionId}${path}`, method, body);
  }

  /** Fire-and-forget input event; input must never throw into the UI. */
  private input(path: string, body?: unknown): void {
    this.session(path, "POST", body).catch(() => {});
  }

  private applyInfo(info: any): void {
    if (!info) return;
    if (info.url !== undefined) {
      this.currentUrl = info.url;
      if (this.urlInput && document.activeElement !== this.urlInput) {
        this.urlInput.value = info.url;
      }
      this.publishContext(info.title);
    }
    if (info.tabs) this.setTabs(info.tabs);
  }

  /** Same state shape + tools hint as the webapp's updateWidgetContext. */
  private publishContext(title?: string): void {
    updateWidgetContext({
      widgetId: "browser",
      widgetType: "BrowserWidget",
      state: {
        url: this.currentUrl,
        title: title || "Browser",
        sessionId: this.sessionId,
        connected: true,
        tools: "You can control this browser. Use your Playwright MCP tools (browser_navigate, browser_click, browser_type, browser_snapshot) if available. The user sees your actions in real time.",
      },
    });
  }

  // ---- Lifecycle ----

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    host.innerHTML = `
      <div class="bp-root">
        <style>${CSS}</style>
        <div class="bp-tabs"></div>
        <div class="bp-toolbar">
          <button class="bp-nav-btn" data-nav="back" title="Back">←</button>
          <button class="bp-nav-btn" data-nav="forward" title="Forward">→</button>
          <button class="bp-nav-btn" data-nav="refresh" title="Refresh">⟳</button>
          <input class="bp-url" placeholder="Enter URL or search…" spellcheck="false">
          <button class="bp-nav-btn" data-nav="newtab" title="New tab (Ctrl+T)">+</button>
        </div>
        <div class="bp-viewport-container" tabindex="0">
          <img class="bp-viewport" alt="">
          <div class="bp-status"><div class="bp-spinner"></div></div>
          <div class="bp-offline" style="display:none">reconnecting…</div>
        </div>
      </div>`;

    this.viewportImg = host.querySelector(".bp-viewport");
    this.viewportContainer = host.querySelector(".bp-viewport-container");
    this.urlInput = host.querySelector(".bp-url");
    this.tabsEl = host.querySelector(".bp-tabs");
    this.statusEl = host.querySelector(".bp-status");
    this.offlineEl = host.querySelector(".bp-offline");

    this.wireToolbar();
    this.wireViewport();
    this.wireResize();

    try {
      const status = await this.api("/status", "GET");
      if (status && status.ready === false) {
        this.showSetupCard(status);
        return;
      }
    } catch {
      // status endpoint unavailable — try creating the session anyway,
      // its error is more specific (same fallback the webapp uses)
    }
    await this.createSession();
  }

  dispose(): void {
    this.destroyed = true;
    removeWidgetContext("browser");
    this.disconnect();
    this.resizeObserver?.disconnect();
    if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
    if (this.mousemoveThrottle) clearTimeout(this.mousemoveThrottle);
    if (this.scrollThrottle) clearTimeout(this.scrollThrottle);
    this.host = null;
    // The server-side session survives panel close on purpose (same as the
    // webapp): the agent may still be using the browser, and state.json
    // persistence makes reopening cheap.
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abort?.abort();
    this.abort = null;
    if (this.frameUrl) {
      URL.revokeObjectURL(this.frameUrl);
      this.frameUrl = null;
    }
  }

  // ---- Session + stream ----

  private async createSession(): Promise<void> {
    const body: any = { session_id: this.sessionId };
    if (this.initialUrl) body.url = this.initialUrl;
    const el = this.viewportContainer;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      body.width = Math.round(el.clientWidth);
      body.height = Math.round(el.clientHeight);
    }
    try {
      const info = await this.api("/sessions", "POST", body);
      this.applyInfo(info);
      void this.connectStream();
      setTimeout(() => this.viewportContainer?.focus(), 100);
    } catch (e: any) {
      this.showError(`Failed to create session: ${e?.message || e}`);
    }
  }

  private async connectStream(): Promise<void> {
    this.disconnect();
    this.abort = new AbortController();
    try {
      const res = await hostFetch(
        `${this.scope.connection.url}/mux/browser/sessions/${this.sessionId}/stream`,
        { headers: authHeaders(this.scope.connection), signal: this.abort.signal },
      );
      if (!res.ok) {
        this.showError(`Stream failed: ${res.status}`);
        return;
      }
      this.setConnected(true);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as FramePayload;
            if (payload.type === "frame") this.onFrame(payload);
          } catch { /* keepalive */ }
        }
      }
      // Server closed the stream — reconnect unless we're going away.
      this.setConnected(false);
      this.scheduleReconnect();
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        this.setConnected(false);
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) void this.connectStream();
    }, 2000);
  }

  private onFrame(payload: FramePayload): void {
    if (this.frameUrl) URL.revokeObjectURL(this.frameUrl);
    const binary = atob(payload.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    this.frameUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    if (this.viewportImg) this.viewportImg.src = this.frameUrl;

    const prevUrl = this.currentUrl;
    if (payload.url) this.currentUrl = payload.url;
    if (payload.viewport_width) this.viewportWidth = payload.viewport_width;
    if (payload.viewport_height) this.viewportHeight = payload.viewport_height;
    if (payload.tabs) this.setTabs(payload.tabs);
    this.setConnected(true);
    this.hideStatus();

    if (this.currentUrl !== prevUrl) {
      this.publishContext(payload.title);
      if (this.urlInput && document.activeElement !== this.urlInput) {
        this.urlInput.value = this.currentUrl;
        // Keystrokes should reach the page, not the URL bar (webapp behavior).
        this.viewportContainer?.focus();
      }
    }

    // Container/viewport mismatch (the gray-bar case) → re-resize.
    const el = this.viewportContainer;
    if (el) {
      const cw = Math.round(el.clientWidth);
      const ch = Math.round(el.clientHeight);
      if (cw > 0 && ch > 0 && (cw !== this.viewportWidth || ch !== this.viewportHeight)) {
        if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
        this.resizeDebounce = setTimeout(() => this.resizeViewport(cw, ch), 150);
      }
    }
  }

  // ---- UI state ----

  private setConnected(connected: boolean): void {
    if (this.offlineEl) this.offlineEl.style.display = connected ? "none" : "";
  }

  private hideStatus(): void {
    if (this.statusEl) this.statusEl.style.display = "none";
  }

  private showError(message: string): void {
    if (!this.statusEl) return;
    this.statusEl.style.display = "";
    this.statusEl.innerHTML = `<div class="bp-msg"></div>`;
    (this.statusEl.querySelector(".bp-msg") as HTMLElement).textContent = message;
  }

  private showSetupCard(status: { message?: string; instructions?: string }): void {
    if (!this.statusEl) return;
    this.statusEl.style.display = "";
    this.statusEl.innerHTML = `
      <div class="bp-msg"></div>
      ${status.instructions ? `<code></code><button class="bp-btn">Copy setup command</button>` : ""}`;
    (this.statusEl.querySelector(".bp-msg") as HTMLElement).textContent =
      status.message || "The browser feature is not available on this server.";
    const code = this.statusEl.querySelector("code");
    if (code) code.textContent = status.instructions || "";
    this.statusEl.querySelector(".bp-btn")?.addEventListener("click", () => {
      if (status.instructions) void navigator.clipboard.writeText(status.instructions);
    });
  }

  private setTabs(tabs: TabInfo[]): void {
    this.tabs = tabs;
    const el = this.tabsEl;
    if (!el) return;
    // Webapp parity (c059ae74): the tab bar is always visible once a session
    // exists — a lone tab still shows its title, and OAuth popups appearing as
    // new tabs are immediately discoverable during login flows.
    el.style.display = tabs.length > 0 ? "" : "none";
    el.innerHTML = "";
    for (const tab of tabs) {
      const t = document.createElement("div");
      t.className = "bp-tab" + (tab.active ? " active" : "");
      t.title = tab.url;
      const title = document.createElement("span");
      title.className = "bp-tab-title";
      title.textContent = tab.title || tab.url || "New Tab";
      t.appendChild(title);
      if (tabs.length > 1) {
        const close = document.createElement("button");
        close.className = "bp-tab-close";
        close.textContent = "×";
        close.title = "Close tab";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(tab.index);
        });
        t.appendChild(close);
      }
      t.addEventListener("click", () => this.switchTab(tab.index));
      el.appendChild(t);
    }
  }

  // ---- Navigation ----

  private navigate(url?: string): void {
    const target = url || this.urlInput?.value?.trim();
    if (!target) return;
    const fullUrl = target.match(/^(https?:\/\/|about:|data:|file:)/) ? target : `https://${target}`;
    if (this.urlInput) this.urlInput.value = fullUrl;
    this.session("/navigate", "POST", { url: fullUrl })
      .then((info) => {
        this.applyInfo(info);
        this.viewportContainer?.focus();
      })
      .catch(() => {});
  }

  private newTab(): void {
    this.session("/tabs", "POST", {})
      .then((info) => {
        this.applyInfo(info);
        this.urlInput?.focus();
        this.urlInput?.select();
      })
      .catch(() => {});
  }

  private switchTab(index: number): void {
    this.session(`/tabs/${index}/activate`, "POST", {})
      .then((info) => {
        this.applyInfo(info);
        this.viewportContainer?.focus();
      })
      .catch(() => {});
  }

  private closeTab(index: number): void {
    if (this.tabs.length <= 1) return;
    this.session(`/tabs/${index}`, "DELETE")
      .then((info) => this.applyInfo(info))
      .catch(() => {});
  }

  private resizeViewport(width: number, height: number): void {
    this.session("/resize", "POST", { width, height })
      .then((info) => {
        if (info?.width) this.viewportWidth = info.width;
        if (info?.height) this.viewportHeight = info.height;
      })
      .catch(() => {});
  }

  // ---- Wiring ----

  private wireToolbar(): void {
    const host = this.host!;
    (host.querySelector('[data-nav="back"]') as HTMLElement).addEventListener("click", () =>
      this.session("/back", "POST", {}).then((i) => this.applyInfo(i)).catch(() => {}));
    (host.querySelector('[data-nav="forward"]') as HTMLElement).addEventListener("click", () =>
      this.session("/forward", "POST", {}).then((i) => this.applyInfo(i)).catch(() => {}));
    (host.querySelector('[data-nav="refresh"]') as HTMLElement).addEventListener("click", () =>
      this.navigate(this.currentUrl));
    (host.querySelector('[data-nav="newtab"]') as HTMLElement).addEventListener("click", () =>
      this.newTab());
    this.urlInput!.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.navigate();
      e.stopPropagation();
    });
    // Webapp parity: focusing the URL bar selects its content, so Ctrl+L or a
    // click lets the user immediately type a replacement URL.
    this.urlInput!.addEventListener("focus", () => this.urlInput!.select());
  }

  private clientToViewport(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = this.viewportImg;
    if (!img) return null;
    // object-fit: contain — compute the letterboxed content box, not the element box.
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / this.viewportWidth, rect.height / this.viewportHeight);
    const cw = this.viewportWidth * scale;
    const ch = this.viewportHeight * scale;
    const left = rect.left + (rect.width - cw) / 2;
    const top = rect.top + (rect.height - ch) / 2;
    const relX = clientX - left;
    const relY = clientY - top;
    if (relX < 0 || relY < 0 || relX > cw || relY > ch) return null;
    return {
      x: Math.round((relX / cw) * this.viewportWidth),
      y: Math.round((relY / ch) * this.viewportHeight),
    };
  }

  private wireViewport(): void {
    const el = this.viewportContainer!;

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el.focus();
      const pos = this.clientToViewport(e.clientX, e.clientY);
      if (!pos) return;
      this.mouseIsDown = true;
      this.dragStartPos = pos;
      this.hasDragged = false;
      this.input("/mousedown", { ...pos, button: e.button === 2 ? "right" : "left" });
    });

    el.addEventListener("mouseup", (e) => {
      const pos = this.clientToViewport(e.clientX, e.clientY);
      if (!pos) return;
      const wasDrag = this.hasDragged;
      this.mouseIsDown = false;
      this.dragStartPos = null;
      this.hasDragged = false;
      this.session("/mouseup", "POST", { ...pos, button: e.button === 2 ? "right" : "left" })
        .then((info) => { if (!wasDrag) this.applyInfo(info); })
        .catch(() => {});
    });

    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const pos = this.clientToViewport(e.clientX, e.clientY);
      if (pos) this.session("/dblclick", "POST", pos).then((i) => this.applyInfo(i)).catch(() => {});
    });

    el.addEventListener("mousemove", (e) => {
      const pos = this.clientToViewport(e.clientX, e.clientY);
      if (!pos) return;
      if (this.mouseIsDown && this.dragStartPos) {
        if (Math.abs(pos.x - this.dragStartPos.x) > 3 || Math.abs(pos.y - this.dragStartPos.y) > 3) {
          this.hasDragged = true;
        }
      }
      if (this.mousemoveThrottle) return;
      this.mousemoveThrottle = setTimeout(() => { this.mousemoveThrottle = null; }, 50);
      this.input("/mousemove", pos);
    });

    el.addEventListener("contextmenu", (e) => e.preventDefault());

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.scrollThrottle) return;
      const pos = this.clientToViewport(e.clientX, e.clientY);
      if (!pos) return;
      this.scrollThrottle = setTimeout(() => { this.scrollThrottle = null; }, 100);
      this.input("/scroll", { ...pos, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
    }, { passive: false });

    el.addEventListener("keydown", (e) => {
      // Ctrl/Cmd+V: the webapp relies on the ClipboardEvent, but WebKitGTK
      // (the Tauri webview) doesn't reliably fire `paste` on non-editable
      // elements — which silently kills pasting passwords into login forms.
      // Read the clipboard directly; fall through to the paste event only if
      // the API is unavailable.
      if (e.key === "v" && (e.ctrlKey || e.metaKey)) {
        if (navigator.clipboard?.readText) {
          e.preventDefault();
          navigator.clipboard.readText()
            .then((text) => { if (text) this.input("/paste", { text }); })
            .catch(() => { /* permission denied — paste event may still fire */ });
        }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "l":
            e.preventDefault();
            this.urlInput?.focus();
            this.urlInput?.select();
            return;
          case "t":
            e.preventDefault();
            this.newTab();
            return;
          case "w": {
            e.preventDefault();
            const active = this.tabs.find((t) => t.active);
            if (active && this.tabs.length > 1) this.closeTab(active.index);
            return;
          }
          case "r":
            e.preventDefault();
            this.navigate(this.currentUrl);
            return;
          default:
            e.preventDefault();
            this.input("/key", { key: `Control+${e.key.toLowerCase()}` });
            return;
        }
      }
      e.preventDefault();
      if (e.key.length === 1) this.input("/type", { text: e.key });
      else this.input("/key", { key: e.key });
    });

    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text");
      if (text) this.input("/paste", { text });
    });
  }

  private wireResize(): void {
    const el = this.viewportContainer!;
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w > 0 && h > 0 && (w !== this.viewportWidth || h !== this.viewportHeight)) {
        if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
        this.resizeDebounce = setTimeout(() => this.resizeViewport(w, h), 150);
      }
    });
    this.resizeObserver.observe(el);
  }
}

registerPanel("browser", () => {
  let panel: BrowserPanel | null = null;
  return {
    mount(host: HTMLElement, params: Record<string, any>) {
      panel = new BrowserPanel(params);
      void panel.mount(host);
    },
    dispose() {
      panel?.dispose();
      panel = null;
    },
  };
});
