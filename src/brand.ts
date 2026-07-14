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
}

const BRANDS: Record<string, Brand> = {
  litai: {
    id: "litai",
    displayName: "LIT",
    windowTitle: "LIT",
    sidecarName: "lit-server",
  },
  jovai: {
    id: "jovai",
    displayName: "JovAI",
    windowTitle: "JovAI",
    sidecarName: "jovai-server",
    logo: "/jovai-logo.png",
  },
};

const id = ((import.meta as any).env?.VITE_LIT_BRAND as string | undefined) || "litai";
export const brand: Brand = BRANDS[id] || BRANDS.litai;
