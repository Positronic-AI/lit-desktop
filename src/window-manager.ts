// Docking window manager for the desktop shell — a vanilla-TS port of the
// webapp's services/window-manager/dockview-window-manager.ts. dockview-core is
// framework-agnostic, so the wrapper ports almost verbatim; the only thing
// removed is the Angular DI (EnvironmentInjector/ApplicationRef) — panel content
// is mounted by VanillaPanelRenderer instead. Same layout persistence contract:
// localStorage <- api.toJSON(), restore via api.fromJSON().

import {
  createDockview,
  type DockviewApi,
  type AddPanelOptions,
  type DockviewIDisposable as IDisposable,
} from "dockview-core";
import { VanillaPanelRenderer } from "./panel-host";

export interface PanelDescriptor {
  id: string;
  component: string;
  title?: string;
  /** Passed to the panel's mount fn (as `params`). */
  params?: Record<string, any>;
  /** Keep the panel's DOM alive when another tab is active (dockview 'always'). */
  persistent?: boolean;
  /** dockview position ({ referencePanel, direction } | { referenceGroup } | { direction }). */
  position?: any;
}

export class WindowManager {
  private _api: DockviewApi | null = null;
  private _disposables: IDisposable[] = [];
  private _layoutKey: string | null = null;
  private _suppressPersist = false;
  private _debounce: ReturnType<typeof setTimeout> | null = null;

  get api(): DockviewApi | null {
    return this._api;
  }

  setLayoutStorageKey(key: string): void {
    this._layoutKey = key;
  }

  /** Match the dock's theme to the app. dockview themes are a CSS class of custom
   *  properties inherited by descendants; we set it on <body> (not just the
   *  container) so floating groups / drop overlays that portal to document.body
   *  are themed too. */
  setTheme(mode: "light" | "dark"): void {
    const el = document.body;
    el.classList.remove("dockview-theme-abyss", "dockview-theme-light", "dockview-theme-dark");
    el.classList.add(mode === "dark" ? "dockview-theme-abyss" : "dockview-theme-light");
  }

  init(container: HTMLElement): void {
    this._api = createDockview(container, {
      createComponent: (options) => new VanillaPanelRenderer(options.name),
    });

    const persistSoon = () => {
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._persist(), 200);
    };

    this._disposables.push(
      this._api.onDidLayoutChange(persistSoon),
      this._api.onDidAddPanel(() => {
        this._updateSingleTabHeaders();
        persistSoon();
      }),
      this._api.onDidRemovePanel(() => {
        this._updateSingleTabHeaders();
        persistSoon();
      }),
      this._api.onDidMovePanel(() => {
        this._updateSingleTabHeaders();
        persistSoon();
      }),
    );
  }

  addPanel(d: PanelDescriptor): string {
    if (!this._api) throw new Error("[WindowManager] not initialized — call init() first");

    const options: AddPanelOptions = {
      id: d.id,
      component: d.component,
      title: d.title || d.component,
      // Carry the component name in params too, so the renderer can resolve it
      // even after a layout restore reconstructs the panel.
      params: { component: d.component, ...(d.params || {}) },
      renderer: d.persistent ? "always" : undefined,
    };

    if (d.position) {
      (options as any).position = d.position;
    } else if (this._api.activePanel) {
      // New panels dock to the right of the active one — side-by-side, not replacing.
      (options as any).position = { referencePanel: this._api.activePanel.id, direction: "right" };
    }

    return this._api.addPanel(options).id;
  }

  hasPanel(id: string): boolean {
    return !!this._api?.getPanel(id);
  }

  focusPanel(id: string): void {
    this._api?.getPanel(id)?.api.setActive();
  }

  removePanel(id: string): void {
    if (!this._api) return;
    const panel = this._api.getPanel(id);
    if (panel) this._api.removePanel(panel);
  }

  /** Restore a saved layout from localStorage. Returns true if one was applied. */
  restore(): boolean {
    if (!this._api || !this._layoutKey) return false;
    const raw = localStorage.getItem(this._layoutKey);
    if (!raw) return false;
    this._suppressPersist = true;
    try {
      this._api.fromJSON(JSON.parse(raw));
      // A restored layout can carry groups whose panels failed to recreate
      // (e.g. a saved panel type mid-refactor). Empty groups are dead space —
      // drop them so a bad save can't wedge the window arrangement.
      for (const group of [...this._api.groups]) {
        if (group.panels.length === 0) this._api.removeGroup(group);
      }
      this._updateSingleTabHeaders();
      return true;
    } catch (e) {
      console.warn("[WindowManager] layout restore failed:", e);
      return false;
    } finally {
      this._suppressPersist = false;
    }
  }

  dispose(): void {
    if (this._debounce) clearTimeout(this._debounce);
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
    this._api?.dispose();
    this._api = null;
  }

  // --- helpers ---

  private _persist(): void {
    if (!this._api || !this._layoutKey || this._suppressPersist) return;
    try {
      localStorage.setItem(this._layoutKey, JSON.stringify(this._api.toJSON()));
    } catch (e) {
      console.warn("[WindowManager] persist failed:", e);
    }
  }

  /** Hide the tab header when there's a single group with a single panel. */
  private _updateSingleTabHeaders(): void {
    if (!this._api) return;
    const multipleGroups = this._api.groups.length > 1;
    for (const group of this._api.groups) {
      group.header.hidden = !multipleGroups && group.panels.length <= 1;
    }
  }
}
