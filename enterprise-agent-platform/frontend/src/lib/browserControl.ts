import type { AgentPreviewScope } from "../types";

export const BROWSER_CONTROL_RELINQUISH_EVENT = "ubitech:browser-control-relinquish";

interface BrowserControlRelinquishDetail extends AgentPreviewScope {
  waitUntil: (operation: Promise<unknown>) => void;
}

export async function relinquishBrowserControlFor(scope: AgentPreviewScope): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const detail: BrowserControlRelinquishDetail = {
    ...scope,
    waitUntil: (operation) => pending.push(operation),
  };
  window.dispatchEvent(new CustomEvent<BrowserControlRelinquishDetail>(
    BROWSER_CONTROL_RELINQUISH_EVENT,
    { detail },
  ));
  await Promise.allSettled(pending);
}

export function browserControlRelinquishScope(event: Event): AgentPreviewScope | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const candidate = detail as Record<string, unknown>;
  if (candidate.scope_type !== "private" && candidate.scope_type !== "channel") return null;
  if (typeof candidate.scope_id !== "string" || !candidate.scope_id) return null;
  return {
    scope_type: candidate.scope_type,
    scope_id: candidate.scope_id,
  };
}

export function waitForBrowserControlRelinquish(event: Event, operation: Promise<unknown>): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
  const waitUntil = (detail as Partial<BrowserControlRelinquishDetail>).waitUntil;
  if (typeof waitUntil === "function") waitUntil(operation);
}
