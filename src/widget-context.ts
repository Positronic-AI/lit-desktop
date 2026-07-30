// Widget-context registry — desktop port of the webapp's WidgetContextService.
//
// Panels that show the user something an agent can act on (the shared browser,
// future viewers) register what they're displaying. When a chat message is
// sent, the contexts ride a client-built <context> envelope embedded in the
// message content — the same shape the webapp's _buildChannelContextEnvelope
// produces, which agents already parse and the desktop's own renderer already
// strips for display. Client-side on purpose: only the client knows what the
// user is actually looking at (a server-side browser session can outlive the
// panel showing it).

export interface WidgetContext {
  widgetId: string;
  widgetType: string;
  state: Record<string, unknown>;
}

const contexts = new Map<string, WidgetContext>();

export function updateWidgetContext(ctx: WidgetContext): void {
  contexts.set(ctx.widgetId, ctx);
}

export function removeWidgetContext(widgetId: string): void {
  contexts.delete(widgetId);
}

export function getWidgetContexts(): WidgetContext[] {
  return [...contexts.values()];
}
