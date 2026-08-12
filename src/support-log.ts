// "Send Logs to Support" — a client-pressable button that ships the local
// backend log to the brand's support dropbox, so support never has to walk a
// client through Explorer on a call (Lais/Katie request, 2026-08-12).
//
// Flow: fetch the sidecar's own log from the LOCAL backend
// (GET /support/local-log — the backend serves its own file, so no Tauri
// fs-scope grant is needed) → POST multipart to brand.supportLogUrl with the
// brand's write-only drop token. Consent is the dialog itself: it names
// exactly what's being sent before anything leaves the machine.

import { brand } from "./brand";
import { getConnections, hostFetch } from "./api";

const NAME_KEY = "lit-support-name";

function supportTarget(): { url: string; token: string } | null {
  if (brand.supportLogUrl && brand.supportDropToken) {
    return { url: brand.supportLogUrl, token: brand.supportDropToken };
  }
  return null;
}

export function supportLogAvailable(): boolean {
  return supportTarget() !== null;
}

export function openSupportLogDialog(): void {
  if (!supportLogAvailable()) return;
  document.getElementById("support-log-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "support-log-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;" +
    "display:flex;align-items:center;justify-content:center;";

  const card = document.createElement("div");
  card.style.cssText =
    "background:#1e2127;color:#e6e6e6;border:1px solid #3a3f4b;" +
    "border-radius:12px;max-width:440px;width:92%;padding:22px 24px;" +
    "font-size:14px;line-height:1.5;box-shadow:0 12px 40px rgba(0,0,0,.5);";
  card.innerHTML = `
    <div style="font-size:17px;font-weight:600;margin-bottom:10px;">🛟 Send Logs to Support</div>
    <div style="color:#b8bec9;margin-bottom:14px;">
      This sends the app's technical log to the ${brand.displayName} support team
      so they can help you without a call. The log contains startup and error
      details and may include file paths and recent app activity. Nothing is
      sent until you press <b>Send</b>.
    </div>
    <label style="display:block;margin-bottom:4px;color:#b8bec9;">Your name (so support knows who this is from)</label>
    <input id="support-log-name" type="text" placeholder="e.g. Katie"
      style="width:100%;box-sizing:border-box;background:#14161b;color:#e6e6e6;
      border:1px solid #3a3f4b;border-radius:8px;padding:8px 10px;margin-bottom:16px;" />
    <div id="support-log-status" style="min-height:20px;color:#b8bec9;margin-bottom:12px;"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button id="support-log-cancel"
        style="background:transparent;color:#b8bec9;border:1px solid #3a3f4b;
        border-radius:8px;padding:8px 16px;cursor:pointer;">Cancel</button>
      <button id="support-log-send"
        style="background:#4c6ef5;color:#fff;border:none;border-radius:8px;
        padding:8px 18px;cursor:pointer;font-weight:600;">Send</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const nameInput = card.querySelector<HTMLInputElement>("#support-log-name")!;
  nameInput.value = localStorage.getItem(NAME_KEY) || "";
  const status = card.querySelector<HTMLElement>("#support-log-status")!;
  const sendBtn = card.querySelector<HTMLButtonElement>("#support-log-send")!;
  const close = () => overlay.remove();
  card.querySelector("#support-log-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  sendBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { status.textContent = "Please enter your name first."; return; }
    localStorage.setItem(NAME_KEY, name);
    sendBtn.disabled = true;
    status.textContent = "Collecting log…";
    try {
      const local = getConnections().find((c) => c.id === "local");
      if (!local) throw new Error("no local backend connection");
      const res = await fetch(`${local.url}/mux/support/local-log`);
      if (!res.ok) throw new Error(`local log fetch failed (${res.status})`);
      const { content } = await res.json();
      if (!content) { status.textContent = "No log found on this machine — nothing to send."; sendBtn.disabled = false; return; }

      status.textContent = "Sending…";
      const version = await import("@tauri-apps/api/app")
        .then((m) => m.getVersion()).catch(() => "unknown");
      // JSON via hostFetch: the Rust-side client dodges webview CORS, and
      // JSON avoids any multipart-serialization questions in the plugin.
      const target = supportTarget();
      if (!target) throw new Error("no support destination for this build");
      const up = await hostFetch(target.url, {
        method: "POST",
        headers: {
          "X-Support-Token": target.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          client_name: name,
          app_version: version,
          client_os: navigator.userAgent.slice(0, 120),
        }),
      });
      if (!up.ok) throw new Error(`upload failed (${up.status})`);
      status.innerHTML = "✅ <b>Sent — thank you!</b> Support has your log and will follow up.";
      sendBtn.textContent = "Done";
      sendBtn.disabled = false;
      sendBtn.onclick = close;
    } catch (e) {
      status.textContent = `Could not send: ${String((e as any)?.message ?? e)}. ` +
        "You can also find the log at ~/.local/share/lit-desktop/logs/backend.log";
      sendBtn.disabled = false;
    }
  });
}
