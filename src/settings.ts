// Settings overlay — Connections (credential pool) + Agents management.
// Ports the web app's credential-pool + agents-lens surfaces to the desktop.

import {
  listCredentials, createCredential, updateCredential, deleteCredential,
  setCredentialApiKey, fetchBackendStatus, backendForVendorMode,
  startOAuth, oauthStatus, submitOAuthCode, cancelOAuth,
  fetchModelsWithConstraints, fetchFullAgents, getAgent, saveAgent, deleteAgent,
  fetchDefaultPrompt,
  type Credential, type Vendor, type CredMode, type FullAgent,
  type BackendModel,
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

let overlay: HTMLElement | null = null;
let onCloseCb: (() => void) | null = null;

export function openSettings(onClose?: () => void): void {
  onCloseCb = onClose || null;
  if (!overlay) {
    overlay = el("div", "settings-overlay");
    overlay.id = "settings-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSettings();
    });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = "";
  overlay.appendChild(buildShell());
  overlay.classList.add("active");
  selectTab("connections");
}

function closeSettings(): void {
  overlay?.classList.remove("active");
  if (onCloseCb) onCloseCb();
}

let bodyEl: HTMLElement;
let tabBtns: Record<string, HTMLElement> = {};

function buildShell(): HTMLElement {
  const modal = el("div", "settings-modal");

  const header = el("div", "settings-header");
  const title = el("h2", undefined, "Settings");
  const close = el("button", "settings-close", "×");
  close.title = "Close";
  close.addEventListener("click", closeSettings);
  header.append(title, close);

  const tabs = el("div", "settings-tabs");
  tabBtns = {};
  for (const [id, label] of [["connections", "Connections"], ["agents", "Agents"]]) {
    const b = el("button", "settings-tab", label);
    b.addEventListener("click", () => selectTab(id));
    tabBtns[id] = b;
    tabs.appendChild(b);
  }

  bodyEl = el("div", "settings-body");
  modal.append(header, tabs, bodyEl);
  return modal;
}

function selectTab(id: string): void {
  for (const [k, b] of Object.entries(tabBtns)) b.classList.toggle("active", k === id);
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("div", "settings-loading", "Loading…"));
  if (id === "connections") renderConnections();
  else renderAgents();
}

// --- Connections tab -------------------------------------------------------

async function renderConnections(): Promise<void> {
  let creds: Credential[] = [];
  try {
    creds = await listCredentials();
  } catch (e) {
    bodyEl.innerHTML = "";
    bodyEl.appendChild(el("div", "settings-error", "Failed to load connections."));
    return;
  }
  bodyEl.innerHTML = "";

  const intro = el("p", "settings-intro", "A Connection is a reusable credential you bind to agents — a subscription login or a metered API key.");
  bodyEl.appendChild(intro);

  if (creds.length === 0) {
    const empty = el("div", "settings-empty");
    empty.append(
      el("p", undefined, "No connections yet."),
      el("p", "muted", "Add your Claude subscription or an API key to get started."),
    );
    bodyEl.appendChild(empty);
  }

  const list = el("div", "cred-list");
  for (const c of creds) list.appendChild(credCard(c));
  bodyEl.appendChild(list);

  const add = el("button", "settings-primary-btn", "+ New connection");
  add.addEventListener("click", () => openCreateWizard());
  bodyEl.appendChild(add);
}

function credCard(c: Credential): HTMLElement {
  const card = el("div", "cred-card");
  const head = el("div", "cred-head");
  const sm = statusMeta(c.status);

  const left = el("div", "cred-head-left");
  left.append(
    el("span", "cred-name", c.name || c.id || "Default"),
    el("span", "cred-badge vendor", vendorMeta(c.vendor).label),
    el("span", "cred-badge mode", modeLabel(c.vendor, c.mode)),
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
    const del = el("button", "settings-danger-link", "Delete connection");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete connection "${c.name}"?`)) return;
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
    panel.appendChild(el("div", "wizard-step-label", "Step 3 · Name this connection"));
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
        if (isKey) {
          await setCredentialApiKey(cred.id!, keyInput!.value.trim());
          renderConnections();
        } else {
          // subscription → OAuth
          const host = el("div");
          panel.innerHTML = "";
          panel.appendChild(host);
          runOAuth(host, cred, () => renderConnections());
        }
      } catch (e) {
        go.textContent = isKey ? "Create & connect" : "Create & sign in";
        go.removeAttribute("disabled");
        err.textContent = "Could not create the connection.";
        err.style.display = "";
      }
    });
    const back = el("button", "settings-mini-btn ghost", "← Back");
    back.addEventListener("click", () => { state.mode = undefined; render(); });
    panel.append(go, err, back);
  };

  bodyEl.innerHTML = "";
  const cancel = el("button", "settings-mini-btn ghost", "← All connections");
  cancel.addEventListener("click", () => renderConnections());
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
      if (r.status === "authenticated" || !r.error) { if (done) done(); else renderConnections(); }
      else throw new Error(r.error || "failed");
    } catch {
      submit.textContent = "Submit code";
      submit.removeAttribute("disabled");
      err.textContent = "That code didn't work. Try again.";
      err.style.display = "";
    }
  });
  const cancel = el("button", "settings-mini-btn ghost", "Cancel");
  cancel.addEventListener("click", () => { cancelOAuth(backend, session!.session_id); renderConnections(); });
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
  let agents: FullAgent[] = [];
  try {
    const [a, m, creds] = await Promise.all([fetchFullAgents(), fetchModelsWithConstraints(), listCredentials()]);
    agents = a;
    allModels = m.models;
    modelConstraints = m.constraints;
    credCache = creds;
  } catch {
    bodyEl.innerHTML = "";
    bodyEl.appendChild(el("div", "settings-error", "Failed to load agents."));
    return;
  }
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "settings-intro", "Agents are your Claudes. Each binds to a Connection and a model."));

  if (agents.length === 0) {
    bodyEl.appendChild(el("div", "settings-empty", "No agents yet."));
  }

  const list = el("div", "agent-rows");
  for (const a of agents) list.appendChild(agentRow(a));
  bodyEl.appendChild(list);

  const add = el("button", "settings-primary-btn", "+ New agent");
  add.addEventListener("click", () => openAgentForm(null));
  bodyEl.appendChild(add);
}

function agentRow(a: FullAgent): HTMLElement {
  const row = el("div", "agent-row");

  const info = el("div", "agent-row-info");
  info.append(el("span", "agent-row-name", a.name || a.id));
  const c = credFor(a.credentials_id);
  const badge = c ? modeLabel(c.vendor, c.mode) : "No connection";
  info.append(el("span", `agent-row-badge ${c ? "" : "muted"}`, badge));
  row.appendChild(info);

  const controls = el("div", "agent-row-controls");

  // Credential select
  const credSel = document.createElement("select");
  credSel.className = "settings-select";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No connection";
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
  const back = el("button", "settings-mini-btn ghost", "← All agents");
  back.addEventListener("click", () => renderAgents());
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
  none.value = ""; none.textContent = "No connection";
  credSel.appendChild(none);
  for (const cr of credCache) {
    if (!cr.id) continue;
    const o = document.createElement("option");
    o.value = cr.id;
    o.textContent = `${cr.name} (${modeLabel(cr.vendor, cr.mode)})`;
    if (cr.id === existing?.credentials_id) o.selected = true;
    credSel.appendChild(o);
  }

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

  const field = (label: string, control: HTMLElement) => {
    const f = el("div", "form-field");
    f.append(el("label", "form-label", label), control);
    return f;
  };

  form.append(
    field("Name", nameInput),
    field("Connection", credSel),
    field("Backend", backendSel),
    field("Model", modelSel),
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
      const base: any = existing ? { ...existing } : { system_prompt: await fetchDefaultPrompt("claude"), temperature: 0.7 };
      await saveAgent({
        ...base,
        id,
        name,
        backend: backendSel.value,
        model: modelSel.value,
        credentials_id: credSel.value || null,
      });
      renderAgents();
    } catch {
      save.textContent = agentId ? "Save agent" : "Create agent";
      save.removeAttribute("disabled");
      err.textContent = "Could not save the agent.";
      err.style.display = "";
    }
  });
  form.append(save, err);
}
