import type { FailedSend } from "../types";
import type { AppStore } from "./loaders";

let failedSendSequence = 0;

export function preserveFailedSend(
  store: AppStore,
  draftKey: string,
  content: string,
  files: File[],
): FailedSend {
  failedSendSequence += 1;
  const send: FailedSend = {
    id: `failed-${Date.now()}-${failedSendSequence}`,
    content,
    // Keep the original File objects grouped with this exact message. Do not
    // merge or cap across failures: each payload already passed per-message
    // attachment validation.
    files: [...files],
  };
  store.dispatch({ type: "ADD_FAILED_SEND", payload: { key: draftKey, send } });
  store.dispatch({ type: "RESTORE_NEXT_FAILED_SEND", payload: { key: draftKey } });
  return send;
}

export function restoreNextFailedSend(store: AppStore, draftKey: string): void {
  store.dispatch({ type: "RESTORE_NEXT_FAILED_SEND", payload: { key: draftKey } });
}
