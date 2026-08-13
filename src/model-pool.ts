// The user's MODEL POOL — port of the webapp's ModelPoolService (2026-08-13
// design session: credentials unlock models). Every (model, credential) tuple
// the user's credentials unlock, rendered "Model · credential" with the
// credential as a muted property. One grammar, every picker.
//
// NOTE: cross-provider dispatch routing lives in lit-lib ≥ 2.6.16
// (heartbeat _resolve_backend_and_model). Against older servers the override
// stores but dispatches wrong — pair desktop releases accordingly.

import { fetchModelsWithConstraints, listCredentials, Scope, activeScope, Credential } from "./api";

export interface PoolEntry {
  backend: string;
  model: string;
  displayName: string;
  provider: string;
  credentialId: string | null;   // null: no credential (ollama)
  credentialName: string | null;
  credentialMode: string | null;
  overrideValue: string;         // "backend:model" — the channel-override wire format
  key: string;                   // unique per (backend, model, credential)
}

export interface PoolGroup {
  provider: string;
  models: PoolEntry[];
}

// Preferred backend per (vendor, mode), first with a live catalog wins.
// MUST mirror _BACKEND_BY_VENDOR_MODE in lit-lib services/credentials.py —
// the authority: a credential's MODE picks the backend, not just its vendor.
const BACKENDS_BY_VENDOR_MODE: Record<string, string[]> = {
  "anthropic:subscription": ["claude-interactive", "claude-cli"],
  "anthropic:api_key": ["claude-cli", "claude"],
  "google:api_key": ["gemini"],
  "google:subscription": ["antigravity"],
  "openai:api_key": ["chatgpt"],
  "openai:subscription": ["chatgpt"],
};

const PROVIDER_LABELS: Record<string, string> = {
  "claude-cli": "Claude", "claude-interactive": "Claude",
  "claude": "Claude API", "codex": "Codex", "chatgpt": "ChatGPT",
  "gemini-cli": "Gemini", "gemini": "Gemini",
  "antigravity": "Antigravity", "ollama": "Ollama (local)",
};

export function providerLabel(backendId: string): string {
  return PROVIDER_LABELS[backendId] || backendId;
}

export function tupleLabel(e: PoolEntry): string {
  return `${e.displayName} · ${e.credentialName || "local"}`;
}

/** Claude's two CLI substrates serve the same models — treat as one provider
 *  when matching an agent's backend against pool entries. */
export function backendsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const twin = (x: string) => x === "claude-cli" || x === "claude-interactive";
  return twin(a) && twin(b);
}

export async function buildModelPool(scope: Scope = activeScope()): Promise<PoolGroup[]> {
  const [modelsResp, creds] = await Promise.all([
    fetchModelsWithConstraints(scope),
    listCredentials("local", scope).catch(() => [] as Credential[]),
  ]);
  const catalogs = modelsResp.models || {};
  const constraints: Record<string, string[]> = modelsResp.constraints || {};

  // SORT ORDER (same as webapp): the model is the noun, the credential its
  // property — iterate MODELS in curated catalog order and emit same-model
  // tuples ADJACENT, subscription before per-token. Fixed provider order,
  // Ollama (local) last.
  const modeRank = (m: string | null) => (m === "subscription" ? 0 : 1);
  const entries: PoolEntry[] = [];
  const vendorOrder = ["anthropic", "openai", "google"];
  const vendors = [...new Set(creds.map((c) => String(c.vendor)))].sort((a, b) => {
    const ia = vendorOrder.indexOf(a), ib = vendorOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (const vendor of vendors) {
    const vendorCreds = creds
      .filter((c) => String(c.vendor) === vendor)
      .sort((a, b) => modeRank(String(a.mode)) - modeRank(String(b.mode)) ||
                      (a.name || "").localeCompare(b.name || ""));
    // Mode picks the backend — bucket credentials by the backend their mode
    // resolves to, keeping the credential sort order.
    const buckets = new Map<string, Credential[]>();
    for (const cred of vendorCreds) {
      const prefs = BACKENDS_BY_VENDOR_MODE[`${vendor}:${cred.mode}`] || [];
      const backend = prefs.find((b) => (catalogs[b] || []).length > 0);
      if (!backend) continue; // credential unlocks no reachable backend
      if (!buckets.has(backend)) buckets.set(backend, []);
      buckets.get(backend)!.push(cred);
    }
    for (const [backend, bucketCreds] of buckets) {
      for (const m of catalogs[backend] || []) {
        for (const cred of bucketCreds) {
          const allow = constraints[`${vendor}:${cred.mode}`];
          if (allow && !allow.includes(m.name)) continue;
          entries.push({
            backend,
            model: m.name,
            displayName: m.display_name || m.name,
            provider: providerLabel(backend),
            credentialId: cred.id,
            credentialName: cred.name || cred.id || "default",
            credentialMode: String(cred.mode),
            overrideValue: `${backend}:${m.name}`,
            key: `${backend}|${m.name}|${cred.id || ""}`,
          });
        }
      }
    }
  }

  for (const m of catalogs["ollama"] || []) {
    entries.push({
      backend: "ollama",
      model: m.name,
      displayName: m.display_name || m.name,
      provider: "Ollama (local)",
      credentialId: null,
      credentialName: null,
      credentialMode: null,
      overrideValue: `ollama:${m.name}`,
      key: `ollama|${m.name}|`,
    });
  }

  const byProvider = new Map<string, PoolEntry[]>();
  for (const e of entries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push(e);
  }
  return Array.from(byProvider.entries()).map(([provider, models]) => ({ provider, models }));
}

/** Resolve an effective model value (plain name or "backend:model") to the
 *  pool entry that should show the checkmark — prefers the tuple bound to the
 *  agent's credential, falls back to the first (backend, model) hit. */
export function findActiveEntry(
  groups: PoolGroup[], effectiveModel: string,
  agentBackend: string, agentCredentialsId: string | null,
  knownBackends: Set<string>,
): PoolEntry | null {
  let backend = agentBackend || "claude-cli";
  let model = effectiveModel || "";
  const idx = model.indexOf(":");
  if (idx > 0 && knownBackends.has(model.slice(0, idx))) {
    backend = model.slice(0, idx);
    model = model.slice(idx + 1);
  }
  const ownCred = agentCredentialsId || "";
  let fallback: PoolEntry | null = null;
  for (const g of groups) {
    for (const e of g.models) {
      if (backendsEquivalent(e.backend, backend) && e.model === model) {
        if ((e.credentialId || "") === ownCred) return e;
        if (!fallback) fallback = e;
      }
    }
  }
  return fallback;
}


// --- Shared filtered picker UI (used by the chat panel's model menu AND the
// settings tuple pickers — one control, every surface) -----------------------

function esc(t: string): string {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

const CHECK_SVG = '<svg class="check-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

/** Append a type-to-filter box + provider-grouped tuple rows to `menu`.
 *  `onPick` receives the chosen entry; the caller owns closing the menu. */
export function attachPoolMenuContent(
  menu: HTMLElement,
  groups: PoolGroup[],
  activeKey: string | null,
  onPick: (e: PoolEntry) => void,
): void {
  const listWrap = document.createElement("div");
  listWrap.className = "model-menu-list";

  const renderRows = (filter: string) => {
    const q = filter.trim().toLowerCase();
    listWrap.innerHTML = "";
    for (const g of groups) {
      const rows = g.models.filter((m) => !q ||
        [m.displayName, m.credentialName || "", g.provider]
          .some((t) => t.toLowerCase().includes(q)));
      if (!rows.length) continue;
      const label = document.createElement("div");
      label.className = "context-menu-item info menu-section-label";
      label.textContent = g.provider;
      listWrap.appendChild(label);
      for (const m of rows) {
        const row = document.createElement("div");
        row.className = "context-menu-item model-menu-item";
        const isActive = activeKey === m.key;
        if (isActive) row.classList.add("active");
        const cred = m.credentialName ? ` · ${m.credentialName}` : " · local";
        row.innerHTML = `<span>${esc(m.displayName)}<span class="pool-cred">${esc(cred)}</span></span>${isActive ? CHECK_SVG : ""}`;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          onPick(m);
        });
        listWrap.appendChild(row);
      }
    }
  };

  // Escape with text clears the filter; Escape with an empty box falls
  // through to the caller's close handling.
  const filterWrap = document.createElement("div");
  filterWrap.className = "model-menu-filter";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter models…";
  filterInput.addEventListener("click", (e) => e.stopPropagation());
  filterInput.addEventListener("input", () => renderRows(filterInput.value));
  filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && filterInput.value) {
      e.stopPropagation();
      filterInput.value = "";
      renderRows("");
    }
  });
  filterWrap.appendChild(filterInput);
  menu.appendChild(filterWrap);
  menu.appendChild(listWrap);
  renderRows("");
  setTimeout(() => filterInput.focus(), 0);
}
