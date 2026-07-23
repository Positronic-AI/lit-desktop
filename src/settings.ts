// Settings overlay — Connections (credential pool) + Agents management.
// Ports the web app's credential-pool + agents-lens surfaces to the desktop.

import {
  listCredentials, createCredential, updateCredential, deleteCredential,
  setCredentialApiKey, fetchBackendStatus, backendForVendorMode,
  startOAuth, oauthStatus, submitOAuthCode, cancelOAuth,
  fetchModelsWithConstraints, fetchFullAgents, getAgent, saveAgent, deleteAgent,
  fetchDefaultPrompt,
  getConnections, saveConnection, removeConnection,
  getActiveConnection, setActiveConnectionId,
  startDeviceAuth, pollDeviceToken, signedInUser,
  type Credential, type Vendor, type CredMode, type FullAgent,
  type BackendModel, type Connection,
} from "./api";

interface VendorMeta {
  id: Vendor;
  label: string;
  blurb: string;
  modes: CredMode[];
  keyUrl: string;
  keyPlaceholder: string;
}

const VENDORS: VendorMeta[] = [
  { id: "anthropic", label: "Anthropic", blurb: "Claude — a Max/Pro plan, or a metered API key.", modes: ["subscription", "api_key"], keyUrl: "https://console.anthropic.com/settings/keys", keyPlaceholder: "sk-ant-…" },
  { id: "google", label: "Google", blurb: "Gemini via AI Studio key, or Antigravity login.", modes: ["api_key", "subscription"], keyUrl: "https://aistudio.google.com/app/apikey", keyPlaceholder: "AIza…" },
  { id: "openai", label: "OpenAI", blurb: "GPT via API key, or a ChatGPT Team login.", modes: ["api_key", "subscription"], keyUrl: "https://platform.openai.com/api-keys", keyPlaceholder: "sk-…" },
];

function vendorMeta(v: Vendor): VendorMeta {
  return VENDORS.find((x) => x.id === v) || VENDORS[0];
}

function modeLabel(vendor: Vendor, mode: CredMode): string {
  if (mode === "subscription") {
    if (vendor === "google") return "Antigravity";
    if (vendor === "openai") return "ChatGPT Team";
    return "Subscription";
  }
  if (mode === "api_key") {
    if (vendor === "google") return "AI Studio";
    return "Pay-per-token";
  }
  return "Local";
}

function statusMeta(status: string): { label: string; cls: string } {
  switch (status) {
    case "authed":
    case "authenticated":
      return { label: "Connected", cls: "ok" };
    case "expiring":
      return { label: "Expiring soon", cls: "warn" };
    case "expired":
    case "token_expired":
      return { label: "Re-auth needed", cls: "err" };
    default:
      return { label: "Not configured", cls: "muted" };
  }
}

function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `cred-${Date.now()}`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function openExternal(url: string): Promise<void> {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

// ---------------------------------------------------------------------------

let onCloseCb: (() => void) | null = null;
let pendingAgentId: string | null = null; // "new" = create form; an id = edit form
// Credential to preselect in the next agent-create form — set by the wizard's
// first-run funnel (fresh credential + zero agents → straight to agent create).
let pendingCredentialId: string | null = null;

// Settings lives in a dock tab like every other surface — one container
// paradigm, no modal. main.ts injects the opener (settings.ts can't import the
// WindowManager without a cycle).
let panelOpener: (() => void) | null = null;
export function registerSettingsOpener(fn: () => void): void {
  panelOpener = fn;
}

export function openSettings(
  onClose?: () => void,
  target?: { tab?: "connections" | "agents"; agentId?: string },
): void {
  onCloseCb = onClose || null;
  pendingAgentId = target?.agentId || null;
  panelOpener?.();
  // Already mounted (tab was open): re-render so a deep-link target (e.g. the
  // agent form) takes effect now rather than on next mount.
  if (bodyEl?.isConnected) renderSetup();
}

/** Panel mount — called by the dock when the Settings tab renders. */
export function mountSettingsPanel(host: HTMLElement): void {
  const wrap = el("div", "settings-panel");
  bodyEl = el("div", "settings-body");
  wrap.appendChild(bodyEl);
  host.appendChild(wrap);
  renderSetup();
}

/** Panel dispose — closing the tab commits the "done configuring" moment. */
export function disposeSettingsPanel(): void {
  const cb = onCloseCb;
  onCloseCb = null;
  cb?.();
}

let bodyEl: HTMLElement;
let connRoot: HTMLElement;   // content container for the Connections section
let agentRoot: HTMLElement;  // content container for the Agents section
// Section-header status chips (webapp Setup's checklist semantics: each
// section says at a glance whether it's done or what's missing).
let connStatusEl: HTMLElement;
let agentStatusEl: HTMLElement;
let serversStatusEl: HTMLElement;

// Single Setup screen: Connections and Agents stacked as two sections, so Agents
// is never hidden behind a tab (mirrors the web app's Setup wizard, where users
// kept missing that they still needed to create an agent).
function renderSetup(): void {
  bodyEl.innerHTML = "";
  const connSection = el("div", "setup-section");
  const connTitle = el("h3", "setup-section-title", "Credentials");
  connStatusEl = el("span", "section-status", "");
  connTitle.appendChild(connStatusEl);
  connSection.appendChild(connTitle);
  connRoot = el("div", "setup-section-body");
  connSection.appendChild(connRoot);

  const agentSection = el("div", "setup-section");
  const agentTitle = el("h3", "setup-section-title", "Agents");
  agentStatusEl = el("span", "section-status", "");
  agentTitle.appendChild(agentStatusEl);
  agentSection.appendChild(agentTitle);
  agentSection.appendChild(
    el("p", "settings-intro", "The model here is the agent's default — override it per channel from the channel's model selector."),
  );
  agentRoot = el("div", "setup-section-body");
  agentSection.appendChild(agentRoot);

  // No tools section: Setup is host-scoped infrastructure (credentials, agents,
  // servers) — the minimum path to "usable". Tool connectors are team-scoped
  // apps, reached from a place (Ctrl+K → "Open app: …"), so the connection you
  // make is unambiguous about whose data it touches (see the 2026-07-23
  // tools-scoping discussion: capability follows agent, authority follows team).

  const serversSection = el("div", "setup-section");
  const serversTitle = el("h3", "setup-section-title", "Connections");
  serversStatusEl = el("span", "section-status", "");
  serversTitle.appendChild(serversStatusEl);
  serversSection.appendChild(serversTitle);
  serversRoot = el("div", "setup-section-body");
  serversSection.appendChild(serversRoot);

  bodyEl.append(serversSection, connSection, agentSection);
  renderConnections();
  renderAgents();
  renderServers();
}

// ---- Servers (connections to LIT hosts) ----
// A connection makes a remote host's teams/channels/agents reachable — the
// desktop stays a client; agents run on the host you're connected to
// (docs/plans/address-model.md). Local is always present and needs no auth.

let serversRoot: HTMLElement;

function renderServers(): void {
  serversRoot.innerHTML = "";
  const active = getActiveConnection();

  const remotes = getConnections().filter((c) => c.id !== "local").length;
  serversStatusEl.textContent = remotes ? `local + ${remotes} remote` : "local only";
  serversStatusEl.className = "section-status ok";

  serversRoot.appendChild(
    el("p", "settings-intro", "A Connection is a LIT server this app can reach. Local is built in; add a connection to work on a remote server too."),
  );

  const list = el("div", "cred-list");
  for (const c of getConnections()) {
    // Same card grammar as credentials and agents: name + badges left,
    // status + actions right.
    const card = el("div", "cred-card");
    const head = el("div", "cred-head conn-head");
    const left = el("div", "cred-head-left");
    left.append(
      el("span", "cred-name", c.name),
      el("span", "cred-badge", c.url),
    );
    if (c.auth === "keycloak") {
      const user = signedInUser(c);
      if (c.refreshToken && user) left.appendChild(el("span", "cred-badge mode-subscription", user));
    }
    const right = el("div", "conn-head-right");
    if (c.auth === "keycloak" && !(c.refreshToken && signedInUser(c))) {
      const signIn = el("button", "settings-mini-btn", "Sign in") as HTMLButtonElement;
      signIn.addEventListener("click", () => deviceSignIn(c, head, signIn));
      right.appendChild(signIn);
    }
    if (c.id === active.id) {
      right.appendChild(el("span", "cred-status ok", "Connected"));
    } else {
      const use = el("button", "settings-mini-btn", "Connect") as HTMLButtonElement;
      use.addEventListener("click", () => {
        const activate = () => {
          setActiveConnectionId(c.id);
          // Same precedent as team flips (and VS Code remotes): the whole
          // workspace scopes to the place — a reload swaps it cleanly.
          window.location.reload();
        };
        // Connect means the whole motion: authenticate if needed, then switch.
        // (Users read "Connect" as "get me onto this server" — honor that.)
        if (c.auth === "keycloak" && !(c.refreshToken && signedInUser(c))) {
          void deviceSignIn(c, head, use, activate);
        } else {
          activate();
        }
      });
      right.appendChild(use);
    }
    if (c.id !== "local") {
      const rm = el("button", "settings-mini-btn ghost", "Remove") as HTMLButtonElement;
      rm.addEventListener("click", () => {
        removeConnection(c.id);
        renderServers();
      });
      right.appendChild(rm);
    }
    head.append(left, right);
    card.appendChild(head);
    list.appendChild(card);
  }
  serversRoot.appendChild(list);

  // Add-server form. Auth server + realm are only needed until servers expose
  // auth discovery; leaving them blank means "no auth" (e.g. a LAN box).
  // Add-flow opens a focused screen with a Back return — the same pattern as
  // the credential wizard and the agent form. One flow, one screen.
  const reveal = el("button", "settings-primary-btn", "+ Add connection") as HTMLButtonElement;
  reveal.addEventListener("click", () => openAddConnection());
  serversRoot.appendChild(reveal);
}

/** Focused add-connection screen. Auth server + realm are only needed until
 *  servers expose auth discovery; blank means "no auth" (e.g. a LAN box). */
function openAddConnection(): void {
  bodyEl.innerHTML = "";
  const back = el("button", "settings-mini-btn ghost", "← Back to setup");
  back.addEventListener("click", () => renderSetup());
  bodyEl.appendChild(back);

  const panel = el("div", "cred-wizard");
  panel.appendChild(el("div", "wizard-step-label", "Add a connection"));
  panel.appendChild(el("p", "settings-intro", "Point the app at a LIT server. Auth server and realm are only needed for servers with sign-in — leave them blank for an open LAN box."));

  const mkInput = (placeholder: string): HTMLInputElement => {
    const i = document.createElement("input");
    i.className = "settings-input wide";
    i.placeholder = placeholder;
    return i;
  };
  const nameInput = mkInput("Name (e.g. JovAI)");
  const urlInput = mkInput("Server URL (https://app.jov.ai)");
  const authInput = mkInput("Auth server (https://auth.lit.ai) — optional");
  const realmInput = mkInput("Realm (JOV-AI) — optional");

  const add = el("button", "settings-primary-btn", "Add connection") as HTMLButtonElement;
  const err = el("div", "settings-error");
  err.style.display = "none";
  add.addEventListener("click", () => {
    const name = nameInput.value.trim();
    const rawUrl = urlInput.value.trim().replace(/\/+$/, "");
    if (!name || !rawUrl) {
      err.textContent = "A name and server URL are required.";
      err.style.display = "";
      return;
    }
    const authUrl = authInput.value.trim().replace(/\/+$/, "");
    const conn: Connection = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `srv-${Date.now()}`,
      name,
      url: rawUrl,
      auth: authUrl ? "keycloak" : "none",
      authUrl: authUrl || undefined,
      realm: realmInput.value.trim() || undefined,
    };
    saveConnection(conn);
    renderSetup();
  });

  panel.append(nameInput, urlInput, authInput, realmInput, add, err);
  bodyEl.appendChild(panel);
}

/** Device-flow sign-in: open the browser to the verification URL, show the
 *  code, poll until approved. One sign-in lasts the Keycloak SSO session —
 *  the 5-minute access tokens refresh themselves from then on. */
async function deviceSignIn(
  conn: Connection,
  row: HTMLElement,
  btn: HTMLButtonElement,
  onSuccess?: () => void,
): Promise<void> {
  btn.disabled = true;
  const status = el("span", "settings-empty", " starting…");
  row.appendChild(status);
  try {
    const start = await startDeviceAuth(conn);
    status.textContent = ` code ${start.user_code} — approve in the browser…`;
    await openExternal(start.verification_uri_complete);
    const deadline = Date.now() + start.expires_in * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.max(start.interval, 5) * 1000));
      if (await pollDeviceToken(conn, start.device_code)) {
        if (onSuccess) onSuccess();
        else renderServers();
        return;
      }
    }
    status.textContent = " sign-in timed out — try again";
    btn.disabled = false;
  } catch (e) {
    status.textContent = ` sign-in failed: ${e instanceof Error ? e.message : e}`;
    btn.disabled = false;
  }
}

// --- Connections tab -------------------------------------------------------

async function renderConnections(): Promise<void> {
  const root = connRoot;
  root.innerHTML = "";
  root.appendChild(el("div", "settings-loading", "Loading…"));
  let creds: Credential[] = [];
  try {
    creds = await listCredentials();
  } catch (e) {
    root.innerHTML = "";
    root.appendChild(el("div", "settings-error", "Failed to load credentials."));
    return;
  }
  root.innerHTML = "";

  const connected = creds.filter((c) => statusMeta(c.status).cls === "ok").length;
  if (creds.length === 0) {
    connStatusEl.textContent = "none yet";
    connStatusEl.className = "section-status warn";
  } else if (connected === creds.length) {
    connStatusEl.textContent = `${connected} connected`;
    connStatusEl.className = "section-status ok";
  } else {
    connStatusEl.textContent = `${connected} of ${creds.length} connected`;
    connStatusEl.className = "section-status warn";
  }

  const intro = el("p", "settings-intro", "A Credential is a subscription login or a metered API key that you bind to agents.");
  root.appendChild(intro);

  if (creds.length === 0) {
    const empty = el("div", "settings-empty");
    empty.append(
      el("p", undefined, "No credentials yet."),
      el("p", "muted", "Add your Claude subscription or an API key to get started."),
      el("p", "muted", "Using local models (Ollama)? No credential needed — skip straight to creating an agent."),
    );
    root.appendChild(empty);
  }

  const list = el("div", "cred-list");
  for (const c of creds) list.appendChild(credCard(c));
  root.appendChild(list);

  const add = el("button", "settings-primary-btn", "+ New credential");
  add.addEventListener("click", () => openCreateWizard());
  root.appendChild(add);
}

function credCard(c: Credential): HTMLElement {
  const card = el("div", "cred-card");
  const head = el("div", "cred-head");
  const sm = statusMeta(c.status);

  const left = el("div", "cred-head-left");
  left.append(
    el("span", "cred-name", c.name || c.id || "Default"),
    el("span", "cred-badge vendor", vendorMeta(c.vendor).label),
    el("span", `cred-badge mode mode-${c.mode}`, modeLabel(c.vendor, c.mode)),
  );
  const status = el("span", `cred-status ${sm.cls}`, sm.label);
  head.append(left, status);
  card.appendChild(head);

  const detail = el("div", "cred-detail");
  detail.style.display = "none";
  card.appendChild(detail);

  head.addEventListener("click", () => {
    const open = detail.style.display !== "none";
    detail.style.display = open ? "none" : "";
    if (!open) renderCredDetail(detail, c);
  });
  return card;
}

async function renderCredDetail(detail: HTMLElement, c: Credential): Promise<void> {
  detail.innerHTML = "";
  detail.appendChild(el("div", "cred-detail-line muted", "Loading status…"));
  const backend = backendForVendorMode(c.vendor, c.mode);
  let st;
  try {
    st = await fetchBackendStatus(backend, c.id || undefined);
  } catch {
    st = null;
  }
  detail.innerHTML = "";

  // Status
  const sm = statusMeta(st?.auth_status || c.status);
  const statusRow = el("div", "cred-detail-line");
  statusRow.append(el("span", "k", "Status"), el("span", `v ${sm.cls}`, sm.label));
  detail.appendChild(statusRow);

  if (st?.token_details?.expires_in) {
    const r = el("div", "cred-detail-line");
    r.append(el("span", "k", "Expires"), el("span", "v", st.token_details.expires_in));
    detail.appendChild(r);
  }
  if (st?.token_details?.scopes?.length) {
    const r = el("div", "cred-detail-line");
    const chips = el("span", "v scopes");
    for (const s of st.token_details.scopes) chips.appendChild(el("span", "scope-chip", s));
    r.append(el("span", "k", "Scopes"), chips);
    detail.appendChild(r);
  }

  if (!c.is_default && c.id) {
    // Rename
    const renameRow = el("div", "cred-action-row");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = c.name;
    nameInput.className = "settings-input";
    const renameBtn = el("button", "settings-mini-btn", "Rename");
    renameBtn.addEventListener("click", async () => {
      renameBtn.textContent = "…";
      try {
        await updateCredential(c.id!, { name: nameInput.value.trim() });
        c.name = nameInput.value.trim();
        renderConnections();
      } catch { renameBtn.textContent = "Failed"; }
    });
    renameRow.append(nameInput, renameBtn);
    detail.appendChild(renameRow);

    // Rotate API key (metered)
    if (c.mode === "api_key") {
      const vm = vendorMeta(c.vendor);
      const keyRow = el("div", "cred-action-row");
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.placeholder = vm.keyPlaceholder;
      keyInput.className = "settings-input";
      const keyBtn = el("button", "settings-mini-btn", "Update key");
      keyBtn.addEventListener("click", async () => {
        if (!keyInput.value.trim()) return;
        keyBtn.textContent = "…";
        try {
          await setCredentialApiKey(c.id!, keyInput.value.trim());
          keyInput.value = "";
          renderCredDetail(detail, c);
        } catch { keyBtn.textContent = "Failed"; }
      });
      keyRow.append(keyInput, keyBtn);
      detail.appendChild(keyRow);
      const link = el("a", "settings-link", "Get an API key →");
      (link as HTMLAnchorElement).href = "#";
      link.addEventListener("click", (e) => { e.preventDefault(); openExternal(vm.keyUrl); });
      detail.appendChild(link);
    }

    // Re-auth (subscription)
    if (c.mode === "subscription") {
      const reauth = el("button", "settings-mini-btn", sm.cls === "ok" ? "Re-authenticate" : "Connect");
      reauth.addEventListener("click", () => runOAuth(detail, c));
      detail.appendChild(reauth);
    }

    // Delete
    const del = el("button", "settings-danger-link", "Delete credential");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete credential "${c.name}"?`)) return;
      try { await deleteCredential(c.id!); renderConnections(); } catch {}
    });
    detail.appendChild(del);
  }
}

// --- Create wizard ---------------------------------------------------------

function openCreateWizard(): void {
  const state: { vendor?: Vendor; mode?: CredMode; name?: string } = {};
  const panel = el("div", "cred-wizard");
  const render = () => {
    panel.innerHTML = "";
    if (!state.vendor) return stepVendor();
    if (!state.mode) return stepMode();
    return stepName();
  };

  const stepVendor = () => {
    panel.appendChild(el("div", "wizard-step-label", "Step 1 · Choose a provider"));
    const grid = el("div", "wizard-grid");
    for (const v of VENDORS) {
      const cardBtn = el("button", "wizard-card");
      cardBtn.append(el("div", "wizard-card-title", v.label), el("div", "wizard-card-blurb", v.blurb));
      cardBtn.addEventListener("click", () => { state.vendor = v.id; state.mode = undefined; render(); });
      grid.appendChild(cardBtn);
    }
    panel.appendChild(grid);
  };

  const stepMode = () => {
    const vm = vendorMeta(state.vendor!);
    panel.appendChild(el("div", "wizard-step-label", `Step 2 · ${vm.label}: how do you pay?`));
    const grid = el("div", "wizard-grid");
    for (const m of vm.modes) {
      const cardBtn = el("button", "wizard-card");
      const blurb = m === "subscription"
        ? "Use an existing plan. Flat cost; sign in once."
        : "Metered API key. Pay only for what you use.";
      cardBtn.append(el("div", "wizard-card-title", modeLabel(state.vendor!, m)), el("div", "wizard-card-blurb", blurb));
      cardBtn.addEventListener("click", () => { state.mode = m; render(); });
      grid.appendChild(cardBtn);
    }
    const back = el("button", "settings-mini-btn ghost", "← Back");
    back.addEventListener("click", () => { state.vendor = undefined; render(); });
    panel.append(grid, back);
  };

  const stepName = () => {
    const vm = vendorMeta(state.vendor!);
    panel.appendChild(el("div", "wizard-step-label", "Step 3 · Name this credential"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "settings-input wide";
    nameInput.placeholder = state.mode === "subscription" ? "e.g. My Claude Max" : "e.g. Metered key";
    panel.appendChild(nameInput);

    const isKey = state.mode === "api_key";
    let keyInput: HTMLInputElement | null = null;
    if (isKey) {
      keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.className = "settings-input wide";
      keyInput.placeholder = vm.keyPlaceholder;
      panel.appendChild(keyInput);
    }

    const go = el("button", "settings-primary-btn", isKey ? "Create & connect" : "Create & sign in");
    const err = el("div", "settings-error");
    err.style.display = "none";
    go.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      if (isKey && !keyInput!.value.trim()) { keyInput!.focus(); return; }
      go.textContent = "Working…";
      go.setAttribute("disabled", "true");
      err.style.display = "none";
      try {
        const cred = await createCredential({ id: slug(name), name, vendor: state.vendor!, mode: state.mode! });
        // First-run funnel: with zero agents, the only sensible next step after
        // connecting is creating the agent — go straight to that form with the
        // fresh credential preselected instead of dropping back to Setup.
        const funnelToAgent = async () => {
          const agents = await fetchFullAgents().catch(() => [] as FullAgent[]);
          if (agents.length === 0) {
            pendingAgentId = "new";
            pendingCredentialId = cred.id ?? null;
          }
          renderSetup();
        };
        if (isKey) {
          await setCredentialApiKey(cred.id!, keyInput!.value.trim());
          await funnelToAgent();
        } else {
          // subscription → OAuth
          const host = el("div");
          panel.innerHTML = "";
          panel.appendChild(host);
          runOAuth(host, cred, () => void funnelToAgent());
        }
      } catch (e) {
        go.textContent = isKey ? "Create & connect" : "Create & sign in";
        go.removeAttribute("disabled");
        err.textContent = "Could not create the credential.";
        err.style.display = "";
      }
    });
    const back = el("button", "settings-mini-btn ghost", "← Back");
    back.addEventListener("click", () => { state.mode = undefined; render(); });
    panel.append(go, err, back);
  };

  // Focused screen: add-flows take over the page with a Back return. Tried
  // inline (2026-07-23) — a half-completed wizard sandwiched between live
  // sections read as three simultaneous states. One flow, one screen.
  bodyEl.innerHTML = "";
  const cancel = el("button", "settings-mini-btn ghost", "← Back to setup");
  cancel.addEventListener("click", () => renderSetup());
  bodyEl.append(cancel, panel);
  render();
}

// OAuth paste-code / device flow, rendered into `host`.
async function runOAuth(host: HTMLElement, c: Credential, done?: () => void): Promise<void> {
  const backend = backendForVendorMode(c.vendor, c.mode);
  host.innerHTML = "";
  host.appendChild(el("div", "cred-detail-line muted", "Starting sign-in…"));
  let session;
  try {
    session = await startOAuth(backend, c.id || undefined);
  } catch {
    host.innerHTML = "";
    host.appendChild(el("div", "settings-error", "Could not start sign-in."));
    return;
  }
  host.innerHTML = "";
  const url = session.oauth_url || session.device_url;
  const box = el("div", "oauth-box");
  box.appendChild(el("div", "oauth-step", "Step 1 — sign in with the browser tab that opened."));
  if (url) {
    const link = el("a", "settings-link", "Open the sign-in page →");
    (link as HTMLAnchorElement).href = "#";
    link.addEventListener("click", (e) => { e.preventDefault(); openExternal(url); });
    box.appendChild(link);
  }
  if (session.device_code) {
    box.appendChild(el("div", "oauth-step", "Step 2 — enter this code, then approve:"));
    box.appendChild(el("div", "oauth-device-code", session.device_code));
    // Device flow: poll for completion
    box.appendChild(el("div", "oauth-poll muted", "Waiting for approval…"));
    host.appendChild(box);
    const poll = async () => {
      try {
        const s = await oauthStatus(backend, session!.session_id);
        if (s.status === "authenticated") { if (done) done(); return; }
        if (s.status === "failed" || s.status === "cancelled") {
          box.appendChild(el("div", "settings-error", "Sign-in failed."));
          return;
        }
      } catch {}
      setTimeout(poll, 2500);
    };
    setTimeout(poll, 2500);
    return;
  }
  // Paste-code flow
  box.appendChild(el("div", "oauth-step", "Step 2 — paste the authentication code:"));
  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.className = "settings-input wide";
  codeInput.placeholder = "Paste code here";
  box.appendChild(codeInput);
  const submit = el("button", "settings-primary-btn", "Submit code");
  const err = el("div", "settings-error");
  err.style.display = "none";
  submit.addEventListener("click", async () => {
    if (!codeInput.value.trim()) return;
    submit.textContent = "Verifying…";
    submit.setAttribute("disabled", "true");
    try {
      const r = await submitOAuthCode(backend, session!.session_id, codeInput.value.trim());
      if (r.status === "authenticated" || !r.error) { if (done) done(); else renderSetup(); }
      else throw new Error(r.error || "failed");
    } catch {
      submit.textContent = "Submit code";
      submit.removeAttribute("disabled");
      err.textContent = "That code didn't work. Try again.";
      err.style.display = "";
    }
  });
  const cancel = el("button", "settings-mini-btn ghost", "Cancel");
  cancel.addEventListener("click", () => { cancelOAuth(backend, session!.session_id); renderSetup(); });
  box.append(submit, err, cancel);
  host.appendChild(box);
}

// --- Agents tab ------------------------------------------------------------

let allModels: Record<string, BackendModel[]> = {};
let modelConstraints: Record<string, string[]> = {};
let credCache: Credential[] = [];

function credFor(id?: string | null): Credential | undefined {
  if (!id) return undefined;
  return credCache.find((c) => c.id === id);
}

function modelsFor(agent: { backend: string; model?: string; credentials_id?: string | null }): BackendModel[] {
  let list = (agent.backend && allModels[agent.backend]) || [];
  const c = credFor(agent.credentials_id);
  const allow = c ? modelConstraints[`${c.vendor}:${c.mode}`] : undefined;
  if (allow) list = list.filter((m) => allow.includes(m.name));
  if (agent.model && !list.some((m) => m.name === agent.model) && (!allow || allow.includes(agent.model))) {
    return [{ name: agent.model, display_name: agent.model }, ...list];
  }
  return list;
}

async function renderAgents(): Promise<void> {
  const root = agentRoot;
  root.innerHTML = "";
  root.appendChild(el("div", "settings-loading", "Loading…"));
  let agents: FullAgent[] = [];
  try {
    const [a, m, creds] = await Promise.all([fetchFullAgents(), fetchModelsWithConstraints(), listCredentials()]);
    agents = a;
    allModels = m.models;
    modelConstraints = m.constraints;
    credCache = creds;
  } catch {
    root.innerHTML = "";
    root.appendChild(el("div", "settings-error", "Failed to load agents."));
    return;
  }
  root.innerHTML = "";

  if (agents.length === 0) {
    agentStatusEl.textContent = "none yet — create one to start chatting";
    agentStatusEl.className = "section-status warn";
  } else {
    const listening = agents.filter((a) => (a as any).heartbeat_enabled).length;
    agentStatusEl.textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"} · ${listening} listening`;
    agentStatusEl.className = `section-status ${listening > 0 ? "ok" : "warn"}`;
  }
  // Opened via the + button or a per-agent gear → jump straight to the form
  // (a focused, full-screen flow that returns to the Setup screen).
  if (pendingAgentId) {
    const id = pendingAgentId;
    pendingAgentId = null;
    openAgentForm(id === "new" ? null : id);
    return;
  }

  if (agents.length === 0) {
    root.appendChild(el("div", "settings-empty", "No agents yet — create one to start chatting."));
  }

  const list = el("div", "agent-rows");
  for (const a of agents) list.appendChild(agentRow(a));
  root.appendChild(list);

  const add = el("button", "settings-primary-btn", "+ New agent");
  add.addEventListener("click", () => openAgentForm(null));
  root.appendChild(add);
}

function agentRow(a: FullAgent): HTMLElement {
  const row = el("div", "agent-row");

  const info = el("div", "agent-row-info");
  info.append(el("span", "agent-row-name", a.name || a.id));
  const c = credFor(a.credentials_id);
  const badge = c ? modeLabel(c.vendor, c.mode) : "No credential";
  info.append(el("span", `agent-row-badge ${c ? "" : "muted"}`, badge));
  row.appendChild(info);

  const controls = el("div", "agent-row-controls");

  // Credential select
  const credSel = document.createElement("select");
  credSel.className = "settings-select";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No credential (local models)";
  credSel.appendChild(none);
  for (const cr of credCache) {
    if (!cr.id) continue;
    const o = document.createElement("option");
    o.value = cr.id;
    o.textContent = `${cr.name} (${modeLabel(cr.vendor, cr.mode)})`;
    if (cr.id === a.credentials_id) o.selected = true;
    credSel.appendChild(o);
  }

  // Model select
  const modelSel = document.createElement("select");
  modelSel.className = "settings-select";
  const fillModels = () => {
    modelSel.innerHTML = "";
    for (const m of modelsFor({ backend: a.backend, model: a.model, credentials_id: credSel.value || null })) {
      const o = document.createElement("option");
      o.value = m.name;
      o.textContent = m.display_name || m.name;
      if (m.name === a.model) o.selected = true;
      modelSel.appendChild(o);
    }
  };
  fillModels();

  credSel.addEventListener("change", async () => {
    await patchAgent(a.id, { credentials_id: credSel.value || null });
    renderAgents();
  });
  modelSel.addEventListener("change", async () => {
    await patchAgent(a.id, { model: modelSel.value });
  });

  const edit = el("button", "settings-mini-btn", "Edit");
  edit.addEventListener("click", () => openAgentForm(a.id));
  const del = el("button", "settings-danger-link", "Delete");
  del.addEventListener("click", async () => {
    if (!confirm(`Delete agent "${a.name || a.id}"?`)) return;
    try { await deleteAgent(a.id); renderAgents(); } catch {}
  });

  controls.append(credSel, modelSel, edit, del);
  row.appendChild(controls);
  return row;
}

// Full-config round-trip: never send partial updates.
async function patchAgent(agentId: string, changes: Partial<FullAgent>): Promise<void> {
  const full = await getAgent(agentId);
  if (!full) return;
  await saveAgent({ ...(full as any), ...changes, id: agentId, name: full.name });
}

async function openAgentForm(agentId: string | null): Promise<void> {
  bodyEl.innerHTML = "";
  const back = el("button", "settings-mini-btn ghost", "← Back to setup");
  back.addEventListener("click", () => renderSetup());
  bodyEl.appendChild(back);

  const form = el("div", "agent-form");
  bodyEl.appendChild(form);

  let existing: FullAgent | null = null;
  if (agentId) {
    existing = await getAgent(agentId);
  }

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "settings-input wide";
  nameInput.placeholder = "Agent name";
  nameInput.value = existing?.name || "";

  const backends = Object.keys(allModels);
  const backendSel = document.createElement("select");
  backendSel.className = "settings-select wide";
  for (const b of backends) {
    const o = document.createElement("option");
    o.value = b;
    o.textContent = b;
    if (b === (existing?.backend || "claude-cli")) o.selected = true;
    backendSel.appendChild(o);
  }

  const credSel = document.createElement("select");
  credSel.className = "settings-select wide";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "No credential (local models)";
  credSel.appendChild(none);
  for (const cr of credCache) {
    if (!cr.id) continue;
    const o = document.createElement("option");
    o.value = cr.id;
    o.textContent = `${cr.name} (${modeLabel(cr.vendor, cr.mode)})`;
    if (cr.id === (existing?.credentials_id ?? pendingCredentialId)) o.selected = true;
    credSel.appendChild(o);
  }
  pendingCredentialId = null;

  const modelSel = document.createElement("select");
  modelSel.className = "settings-select wide";
  const fillModels = () => {
    modelSel.innerHTML = "";
    for (const m of modelsFor({ backend: backendSel.value, model: existing?.model, credentials_id: credSel.value || null })) {
      const o = document.createElement("option");
      o.value = m.name; o.textContent = m.display_name || m.name;
      if (m.name === existing?.model) o.selected = true;
      modelSel.appendChild(o);
    }
  };
  fillModels();
  backendSel.addEventListener("change", fillModels);
  credSel.addEventListener("change", fillModels);

  // Role — system prompt (defaults to the backend's default for new agents).
  const promptInput = document.createElement("textarea");
  promptInput.className = "settings-input wide";
  promptInput.rows = 7;
  promptInput.value = existing?.system_prompt || "";
  if (!existing) fetchDefaultPrompt("claude").then((p) => { if (!promptInput.value) promptInput.value = p; });

  // Advanced — temperature + reasoning effort.
  const tempInput = document.createElement("input");
  tempInput.type = "number"; tempInput.min = "0"; tempInput.max = "1"; tempInput.step = "0.1";
  tempInput.className = "settings-input wide";
  tempInput.value = String(existing?.temperature ?? 0.7);

  const effortSel = document.createElement("select");
  effortSel.className = "settings-select wide";
  for (const e of ["", "low", "medium", "high", "xhigh", "max"]) {
    const o = document.createElement("option");
    o.value = e; o.textContent = e || "(default)";
    if ((existing?.effort || "") === e) o.selected = true;
    effortSel.appendChild(o);
  }

  // Heartbeat — whether the agent listens and responds to channel messages.
  // Durable config for the old composer heart button (new agents: on).
  const listenWrap = el("label", "form-check");
  const listenInput = document.createElement("input");
  listenInput.type = "checkbox";
  listenInput.checked = existing ? Boolean((existing as any).heartbeat_enabled) : true;
  listenWrap.append(listenInput, document.createTextNode(" Listening — responds to channel messages"));

  const field = (label: string, control: HTMLElement) => {
    const f = el("div", "form-field");
    f.append(el("label", "form-label", label), control);
    return f;
  };

  form.append(
    field("Name", nameInput),
    field("Credential", credSel),
    field("Backend", backendSel),
    field("Model", modelSel),
    listenWrap,
    el("div", "form-section-label", "Role"),
    field("System prompt", promptInput),
    el("div", "form-section-label", "Advanced"),
    field("Temperature", tempInput),
    field("Reasoning effort", effortSel),
  );

  const save = el("button", "settings-primary-btn", agentId ? "Save agent" : "Create agent");
  const err = el("div", "settings-error");
  err.style.display = "none";
  save.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    save.textContent = "Saving…";
    save.setAttribute("disabled", "true");
    err.style.display = "none";
    try {
      const id = agentId || slug(name);
      const base: any = existing ? { ...existing } : {};
      await saveAgent({
        ...base,
        id,
        name,
        backend: backendSel.value,
        model: modelSel.value,
        credentials_id: credSel.value || null,
        system_prompt: promptInput.value,
        temperature: parseFloat(tempInput.value) || 0.7,
        effort: effortSel.value || null,
        // An agent that can't hear the channel is indistinguishable from a
        // broken install (Spuds, 2026-07-23). New agents listen by default.
        heartbeat_enabled: listenInput.checked,
      });
      renderSetup();
    } catch {
      save.textContent = agentId ? "Save agent" : "Create agent";
      save.removeAttribute("disabled");
      err.textContent = "Could not save the agent.";
      err.style.display = "";
    }
  });
  form.append(save, err);
}
