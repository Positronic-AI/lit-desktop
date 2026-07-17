// Vanilla-TS bridge between dockview-core and the desktop's plain-DOM panels.
//
// The webapp mounts an Angular component into each dockview panel via a ~90-line
// AngularPanelRenderer (createComponent + ApplicationRef.attachView + input/output
// wiring). We have no framework to bridge — a panel's content is just an
// HTMLElement we populate — so this is the whole equivalent: dockview asks for a
// renderer, we hand back a host <div> and delegate to a registered mount fn.

import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview-core";

/** How a panel type builds (and tears down) its content inside a host element. */
export interface PanelMount {
  /** Populate `host` with this panel's DOM. Called once when the panel renders. */
  mount(host: HTMLElement, params: Record<string, any>): void;
  /** Optional cleanup when the panel is closed. */
  dispose?(): void;
}

const REGISTRY = new Map<string, () => PanelMount>();

/** Register a panel type by name (the `component` string used in addPanel). */
export function registerPanel(name: string, factory: () => PanelMount): void {
  REGISTRY.set(name, factory);
}

/**
 * dockview-core content renderer. dockview calls `createComponent({ name })` per
 * panel; we return one of these. It owns a host <div> and, on init, looks up the
 * registered mount fn for its component and runs it.
 */
export class VanillaPanelRenderer implements IContentRenderer {
  readonly element: HTMLDivElement;
  private _mount: PanelMount | null = null;

  constructor(private readonly _component: string) {
    this.element = document.createElement("div");
    this.element.className = "dv-panel-content";
  }

  init(params: GroupPanelPartInitParameters): void {
    const factory = REGISTRY.get(this._component);
    if (!factory) {
      this.element.textContent = `Unknown panel: ${this._component}`;
      return;
    }
    this._mount = factory();
    this._mount.mount(this.element, (params.params as Record<string, any>) || {});
  }

  dispose(): void {
    this._mount?.dispose?.();
    this._mount = null;
  }
}
