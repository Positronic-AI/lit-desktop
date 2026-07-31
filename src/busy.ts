/**
 * Registry of in-flight work worth confirming before the window closes.
 *
 * Closing the app now kills everything it spawned (src-tauri/src/lib.rs) — that
 * is deliberate, but a stray close during a 20-minute vetting batch is an
 * expensive accident, so we ask first.
 *
 * Contract: `busyLabels()` is SYNCHRONOUS and reads only local state. The close
 * handler must never await a network call to decide whether to prompt — a wedged
 * or offline backend would then make the app impossible to close.
 */
import { hostFetch, authHeaders, type Connection } from "./api";

const sources = new Map<string, string>();

export function markBusy(key: string, label: string): void {
  sources.set(key, label);
}

export function clearBusy(key: string): void {
  sources.delete(key);
}

/** Distinct labels for whatever is running right now. Never async. */
export function busyLabels(): string[] {
  return [...new Set(sources.values())];
}

const watched = new Set<string>();

/**
 * Poll a channel's orchestration until it finishes, holding a busy marker while
 * it runs. Polling happens in the background precisely so the close handler
 * stays synchronous.
 *
 * A STALE marker is worse than a missing one — it would nag on every close
 * forever — so any error clears the marker and stops the watch. The reaper is
 * unaffected either way; we simply stop claiming work is in flight.
 */
export function watchOrchestration(conn: Connection, channelId: string): void {
  const key = `orch:${channelId}`;
  if (watched.has(key)) return;
  watched.add(key);

  let failures = 0;
  const poll = async (): Promise<void> => {
    try {
      const res = await hostFetch(
        `${conn.url}/mux/channels/${encodeURIComponent(channelId)}/orchestrations/status`,
        { headers: authHeaders(conn) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      failures = 0;
      if (!body?.active) {
        clearBusy(key);
        watched.delete(key);
        return;
      }
      const name = body.name || body.slug || "An orchestration";
      const step = body.step ? ` — ${body.step}` : "";
      markBusy(key, `${name}${step}`);
    } catch {
      if (++failures >= 3) {
        clearBusy(key);
        watched.delete(key);
        return;
      }
    }
    setTimeout(poll, 15000);
  };
  void poll();
}
