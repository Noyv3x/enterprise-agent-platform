import type { AgentPreviewScope } from "../types";

export interface RealtimePreviewUpdate {
  scope: AgentPreviewScope;
  browserActive?: boolean;
  runningTerminalCount?: number;
}

type PreviewListener = (update: RealtimePreviewUpdate) => void;

const previewListeners = new Set<PreviewListener>();

export function publishRealtimePreview(update: RealtimePreviewUpdate): void {
  for (const listener of [...previewListeners]) listener(update);
}

export function subscribeRealtimePreview(listener: PreviewListener): () => void {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}
