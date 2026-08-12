// White-label branding, selected at build time via VITE_LIT_BRAND (default: litai).
// Build a JovAI variant with: VITE_LIT_BRAND=jovai npm run build
// The Tauri-side name/identifier/icon are overridden separately by a config
// overlay (src-tauri/tauri.<brand>.conf.json) at `tauri build` time.

export interface Brand {
  id: string;
  displayName: string; // shown in-app (welcome text, etc.)
  windowTitle: string; // webview document title
  sidecarName: string; // Tauri sidecar basename (must match externalBin in the build)
  logo?: string;       // optional wordmark shown in the empty state (served from public/)
  // Support-log dropbox: where "Send Logs to Support" uploads. The token is a
  // deliberately-public WRITE-ONLY credential (rate-limited dropbox — nothing
  // readable behind it); it must match LIT_SUPPORT_DROP_TOKEN on that server.
  supportLogUrl?: string;
  supportDropToken?: string;
}

const BRANDS: Record<string, Brand> = {
  litai: {
    id: "litai",
    displayName: "LIT",
    windowTitle: "LIT",
    sidecarName: "lit-server",
    // app.lit.ai is an NPM proxy host (added 2026-08-12) — today it fronts
    // the dev node; the domain is the stable interface, the target moves
    // freely behind it (one-node model).
    supportLogUrl: "https://app.lit.ai/mux/support/logs",
    supportDropToken: "sptk_litai_41b48bbd91756c800e3d22385393291d8ef0dc4f",
  },
  jovai: {
    id: "jovai",
    displayName: "JovAI",
    windowTitle: "JovAI",
    sidecarName: "jovai-server",
    logo: "/jovai-logo.png",
    supportLogUrl: "https://app.jov.ai/mux/support/logs",
    supportDropToken: "sptk_jovai_17cd90f86c1555bbc5d481fe2bdcd397d47297a8",
  },
};

const id = ((import.meta as any).env?.VITE_LIT_BRAND as string | undefined) || "litai";
export const brand: Brand = BRANDS[id] || BRANDS.litai;
