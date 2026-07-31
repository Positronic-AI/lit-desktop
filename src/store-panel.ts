// App Store panel — thin client over the sidecar's /store endpoints.
// Design: lit-platform docs/plans/app-store-github.md. A GitHub repo IS the
// store; this panel just lists catalogs and pushes Install/Update buttons.
// Sketch quality on purpose (feat/store-panel branch): sectioned list,
// add-store form, no polish. The sidecar owns all fetching/auth/extraction.

import { registerPanel } from "./panel-host";
import { hostFetch, authHeaders, activeScope, type Scope } from "./api";

async function storeApi(path: string, body?: unknown): Promise<any> {
  const scope: Scope = activeScope();
  const res = await hostFetch(`${scope.connection.url}/mux/store/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(scope.connection) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
  return data;
}

const CSS = `
.store-panel { padding: 12px; overflow-y: auto; height: 100%; font-size: 13px; }
.store-repo { margin: 14px 0 6px; font-weight: 600; opacity: 0.75; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.store-row { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color, #333); margin-bottom: 8px; }
.store-info { flex: 1; min-width: 0; }
.store-title { font-weight: 600; }
.store-desc { opacity: 0.7; margin-top: 2px; }
.store-chips { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.store-chip { font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border-color, #444); opacity: 0.8; }
.store-chip.ok { border-color: #3a7; color: #3a7; }
.store-chip.upd { border-color: #ca3; color: #ca3; }
.store-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid var(--border-color, #555); background: transparent; color: inherit; cursor: pointer; }
.store-btn:hover { border-color: #888; }
.store-btn[disabled] { opacity: 0.5; cursor: default; }
.store-add { display: flex; gap: 6px; margin-top: 14px; }
.store-add input { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color, #444); background: transparent; color: inherit; }
.store-err { color: #d66; margin: 8px 0; }
.store-empty { opacity: 0.6; margin: 10px 0; }
`;

registerPanel("store", () => {
  let root: HTMLElement | null = null;

  async function refresh(): Promise<void> {
    if (!root) return;
    const list = root.querySelector(".store-list") as HTMLElement;
    const err = root.querySelector(".store-err") as HTMLElement;
    err.textContent = "";
    list.innerHTML = `<div class="store-empty">Loading…</div>`;
    try {
      const { stores } = await storeApi("catalog");
      list.innerHTML = "";
      if (!stores?.length) {
        list.innerHTML = `<div class="store-empty">No stores yet — add one below (a GitHub repo URL).</div>`;
        return;
      }
      for (const store of stores) {
        const head = document.createElement("div");
        head.className = "store-repo";
        head.textContent = store.repo;
        list.appendChild(head);
        if (store.error) {
          const e = document.createElement("div");
          e.className = "store-err";
          e.textContent = `Could not read this store: ${store.error}`;
          list.appendChild(e);
          continue;
        }
        if (!store.packages.length) {
          const e = document.createElement("div");
          e.className = "store-empty";
          e.textContent = "No packages in this store.";
          list.appendChild(e);
        }
        for (const pkg of store.packages) {
          list.appendChild(renderRow(store.repo, pkg));
        }
      }
    } catch (e: any) {
      err.textContent = e?.message || "Failed to load catalog";
      list.innerHTML = "";
    }
  }

  function renderRow(repo: string, pkg: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "store-row";
    const state = pkg.owned_by_other_store
      ? `<span class="store-chip">installed via another store</span>`
      : pkg.update_available
        ? `<span class="store-chip upd">update available</span>`
        : pkg.installed
          ? `<span class="store-chip ok">installed</span>`
          : "";
    row.innerHTML = `
      <div class="store-info">
        <div class="store-title">${pkg.title || pkg.name}</div>
        <div class="store-desc">${pkg.description || ""}</div>
        <div class="store-chips">
          ${(pkg.components || []).map((c: string) => `<span class="store-chip">${c}</span>`).join("")}
          ${state}
        </div>
      </div>`;
    const btn = document.createElement("button");
    btn.className = "store-btn";
    btn.textContent = pkg.update_available ? "Update" : pkg.installed ? "Reinstall" : "Install";
    if (pkg.owned_by_other_store) btn.disabled = true;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Installing…";
      try {
        await storeApi("install", { repo, package: pkg.name });
        btn.textContent = "Installed ✓";
        setTimeout(() => void refresh(), 800);
      } catch (e: any) {
        btn.textContent = "Failed";
        btn.disabled = false;
        const err = root?.querySelector(".store-err") as HTMLElement;
        if (err) err.textContent = e?.message || "Install failed";
      }
    });
    row.appendChild(btn);
    return row;
  }

  return {
    mount(host: HTMLElement) {
      root = host;
      host.innerHTML = `
        <div class="store-panel">
          <style>${CSS}</style>
          <div class="store-err"></div>
          <div class="store-list"></div>
          <div class="store-add">
            <input class="store-add-repo" placeholder="github.com/owner/store-repo or https://store URL" spellcheck="false">
            <input class="store-add-token" placeholder="token (private repos)" type="password" spellcheck="false">
            <button class="store-btn store-add-btn">Add store</button>
          </div>
        </div>`;
      const addBtn = host.querySelector(".store-add-btn") as HTMLButtonElement;
      addBtn.addEventListener("click", async () => {
        const repo = (host.querySelector(".store-add-repo") as HTMLInputElement).value.trim();
        const token = (host.querySelector(".store-add-token") as HTMLInputElement).value.trim();
        if (!repo) return;
        addBtn.disabled = true;
        try {
          await storeApi("subscriptions", token ? { repo, token } : { repo });
          (host.querySelector(".store-add-repo") as HTMLInputElement).value = "";
          (host.querySelector(".store-add-token") as HTMLInputElement).value = "";
          await refresh();
        } catch (e: any) {
          (host.querySelector(".store-err") as HTMLElement).textContent = e?.message || "Add failed";
        } finally {
          addBtn.disabled = false;
        }
      });
      void refresh();
    },
    dispose() { root = null; },
  };
});
