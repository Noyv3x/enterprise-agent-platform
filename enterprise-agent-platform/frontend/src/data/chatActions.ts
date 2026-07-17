/* =====================================================================
   Chat data/realtime actions (Phase 3 scope).

   This file owns:
   - refreshActiveChat(store): the SSE "update" + 4s poll target. Re-fetches the
     active scope's messages and dispatches ONLY when a cheap fingerprint differs
     (the legacy chatSnapshot no-op gate, legacy-app.js:3263-3284), so identical
     poll/SSE payloads cause zero state change and never disturb scroll/focus.
   - currentScopeStreamUrl(state): the SSE URL by view (legacy-app.js:3309-3313).
   - navigateToView / selectChannel: the nav -> loader wiring (legacy navItem +
     channel button onclick, legacy-app.js:453-501).
   - pollInFlight mutex shared by SSE + poll.

   sendMessage (the optimistic send lifecycle, spec §7-8) and the typing notifier
   are filled in Phase 4a — see the TODO stub at the bottom (the typing notifier
   already lives in hooks/useTypingNotifier.ts).
   ===================================================================== */

import {
  api,
  ApiRequestCancelledError,
  isApiRequestCancelled,
  type ApiOptions,
} from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { toast } from "../context/ToastContext";
import { t } from "../i18n";
import { agentStatusFor, scopeIdFor, scopeTypeFor } from "../store/selectors";
import { optimisticAttachments } from "../utils/composerFiles";
import { chatSnapshot } from "../utils/fingerprint";
import { runBusy } from "./sessionActions";
import { ensureResource, resourceKeys, runResourceLoad } from "./resourceState";
import { ensureAdminPageResource } from "./adminResources";
import {
  beginStatusMutation,
  finishStatusMutation,
  isStatusMutationCurrent,
  isStatusReadCurrent,
  issueStatusRead,
} from "./statusFence";
import {
  loadChannelMessages,
  loadDocuments,
  loadPrivateMessages,
  type AppStore,
} from "./loaders";
import type {
  ActiveView,
  AgentApprovalChoice,
  AgentApprovalSubmitResponse,
  AgentStatus,
  AppState,
  ChannelMessagesResponse,
  ChatMode,
  Id,
  Message,
  PostMessageResponse,
  PrivateMessagesResponse,
  PrivateTelegramResponse,
} from "../types";

/* The cross-source re-entrancy mutex (legacy module-level `pollInFlight`): SSE
   update handlers and the 4s poll both call refreshActiveChat and must not
   overlap. */
let pollInFlight = false;

/* --------- local mirrors of the loaders' private merge/status helpers ---------
   refreshActiveChat fetches directly (instead of via the dispatching loaders) so
   it can compare a before/after fingerprint and dispatch only on change; these
   two helpers reproduce loaders.ts:mergePending / applyAgentStatus exactly. */

function mergePending(
  state: AppState,
  mode: ChatMode,
  scopeId: string,
  messages: Message[],
): Message[] {
  const scopeType = scopeTypeFor(mode);
  const pending = state.pendingMessages.filter(
    (message) => message.scope_type === scopeType && message.scope_id === String(scopeId),
  );
  return [...messages, ...pending];
}

function applyAgentStatus(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  status: AgentStatus | null | undefined,
  authoritative = false,
): void {
  if (!status) return;
  store.dispatch({
    type: "SET_AGENT_STATUS",
    payload: { mode, scopeId, status, authoritative },
  });
}

async function runStatusMutation<T extends { agent_status?: AgentStatus | null }>(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const ticket = beginStatusMutation(store, mode, scopeId);
  try {
    const result = await operation();
    if (isStatusMutationCurrent(ticket)) {
      applyAgentStatus(store, mode, scopeId, result.agent_status, true);
    }
    return result;
  } finally {
    finishStatusMutation(ticket);
  }
}

/* ----------------------------------------------------------- scope stream */

/** The active scope's SSE URL (legacy currentScopeStreamUrl). */
export function currentScopeStreamUrl(state: AppState): string | null {
  if (state.activeView === "channel" && state.activeChannelId) {
    return endpoints.channelEvents.path(state.activeChannelId);
  }
  if (state.activeView === "private") return endpoints.privateEvents.path();
  return null;
}

/* ------------------------------------------------------- refreshActiveChat */

function scopeModeFor(view: ActiveView): ChatMode | null {
  return view === "private" ? "private" : view === "channel" ? "channel" : null;
}

/** Re-fetch the active scope and dispatch only when the fingerprint differs.
 *  Best-effort: explicit user actions surface their own errors. */
export async function refreshActiveChat(store: AppStore): Promise<void> {
  const initial = store.getState();
  if (!initial.user || pollInFlight) return;
  const mode = scopeModeFor(initial.activeView);
  if (!mode) return;
  if (mode === "channel" && !initial.activeChannelId) return;

  pollInFlight = true;
  try {
    if (mode === "channel") {
      const channelId = String(initial.activeChannelId);
      const statusRead = issueStatusRead(store, "channel", channelId);
      const result = await api<ChannelMessagesResponse>(endpoints.channelMessages.path(channelId));
      const state = store.getState();
      // Channel-switch race guard: discard a response for a channel we left.
      if (String(state.activeChannelId) !== channelId) return;
      if (!isStatusReadCurrent(statusRead)) return;
      const before = chatSnapshot(
        "channel",
        channelId,
        state.messages,
        agentStatusFor(state, "channel"),
        state.typingUsers,
      );
      const nextMessages = mergePending(state, "channel", channelId, result.messages || []);
      const nextStatus = result.agent_status ?? agentStatusFor(state, "channel");
      const nextTyping = result.typing || [];
      const after = chatSnapshot("channel", channelId, nextMessages, nextStatus, nextTyping);
      if (before === after) return;
      store.dispatch({ type: "SET_MESSAGES", payload: nextMessages });
      applyAgentStatus(store, "channel", channelId, result.agent_status, true);
      store.dispatch({ type: "SET_TYPING_USERS", payload: nextTyping });
    } else {
      const scopeId = scopeIdFor(initial, "private");
      const statusRead = issueStatusRead(store, "private", scopeId);
      const [messagesResult, telegramResult] = await Promise.all([
        api<PrivateMessagesResponse>(endpoints.privateMessages.path()),
        api<PrivateTelegramResponse>(endpoints.privateTelegram.path()),
      ]);
      const state = store.getState();
      // Telegram is refreshed alongside private messages but updated INDEPENDENTLY
      // of the message/agent fingerprint gate (legacy applied it unconditionally),
      // so a link/unlink/status change that doesn't touch messages still surfaces.
      if (JSON.stringify(telegramResult) !== JSON.stringify(state.privateTelegram)) {
        store.dispatch({ type: "SET_PRIVATE_TELEGRAM", payload: telegramResult });
      }
      if (!isStatusReadCurrent(statusRead)) return;
      const before = chatSnapshot(
        "private",
        scopeId,
        state.privateMessages,
        agentStatusFor(state, "private"),
        [],
      );
      const nextMessages = mergePending(state, "private", scopeId, messagesResult.messages || []);
      const nextStatus = messagesResult.agent_status ?? agentStatusFor(state, "private");
      const after = chatSnapshot("private", scopeId, nextMessages, nextStatus, []);
      if (before === after) return;
      store.dispatch({ type: "SET_PRIVATE_MESSAGES", payload: nextMessages });
      applyAgentStatus(store, "private", scopeId, messagesResult.agent_status, true);
    }
  } catch {
    // Polling/SSE refresh is best-effort.
  } finally {
    pollInFlight = false;
  }
}

/* ---------------------------------------------------------- nav -> loader */

/** Switch the workspace view + close the drawer, then fire the view's loader
 *  (legacy navItem onclick, legacy-app.js:489-501). Channel view loads via
 *  selectChannel / existing state, so it has no loader here. */
export async function navigateToView(store: AppStore, view: ActiveView): Promise<void> {
  store.dispatch({ type: "SET_ACTIVE_VIEW", payload: view });
  store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
  if (view !== "private") {
    store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false });
  }
  if (view === "private") {
    await runResourceLoad(store, resourceKeys.privateChat, () => loadPrivateMessages(store));
  } else if (view === "knowledge") {
    await ensureResource(store, resourceKeys.knowledgeList, () => loadDocuments(store));
  }
  else if (view === "admin") {
    await ensureAdminPageResource(store, store.getState().activeAdminPage);
  }
}

/** Select a channel + close the drawer, then load its messages (legacy channel
 *  button onclick, legacy-app.js:453-459). */
export async function selectChannel(store: AppStore, channelId: Id): Promise<void> {
  store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "channel" });
  store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: channelId });
  store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
  store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false });
  await runResourceLoad(store, resourceKeys.channelChat(channelId), () => loadChannelMessages(store));
}

/* ----------------------------------------------------- optimistic send */

/* Monotonic counter for optimistic tmp ids + attachment ids (legacy module-level
   localMessageSeq, legacy-app.js:65). */
let localMessageSeq = 0;

/* Private messages are shown optimistically but their POSTs are serialized per
   store/scope. This preserves the user's send order when Enter is pressed several
   times quickly, allowing the backend to steer messages 2..N into the run started
   by message 1. A rejected item cannot poison the tail. */
const privateSendTails = new WeakMap<AppStore, Map<string, Promise<void>>>();

function enqueuePrivatePost<T>(
  store: AppStore,
  scopeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = privateSendTails.get(store);
  if (!queues) {
    queues = new Map();
    privateSendTails.set(store, queues);
  }
  const key = String(scopeId);
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues?.get(key) === tail) queues.delete(key);
  });
  return result;
}

/** Build the optimistic user message (legacy appendOptimisticMessage, :2963-2981).
 *  optimisticAttachments mints blob: preview URLs that are revoked in the slice's
 *  REPLACE/REMOVE transition (and on logout). */
function buildOptimisticMessage(
  state: AppState,
  mode: ChatMode,
  scopeId: string,
  content: string,
  files: File[],
  seq: number,
): Message {
  return {
    id: `tmp-${seq}`,
    scope_type: scopeTypeFor(mode),
    scope_id: String(scopeId),
    author_type: "user",
    user_id: state.user?.id ?? null,
    username: state.user?.display_name || state.user?.username || t("chat.you"),
    content,
    attachments: optimisticAttachments(files, seq),
    metadata: { local_pending: true },
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** The core send mutation (legacy postChatMessage, :3006-3036). Optimistic insert
 *  -> POST (multipart with files, else JSON {content}) -> replace temp with the
 *  saved user_message (SSE dedupe-guarded in the reducer) + set agent_status ->
 *  refresh; on error remove the temp message + toast "发送失败" and return false.
 *  Private POSTs use a per-scope FIFO while channel POSTs retain their existing
 *  independent behavior.
 *  Focus/scroll are component-owned (ChatView's focusToken / forceBottomToken), so
 *  this never touches them. Payloads are byte-for-byte preserved. */
export async function sendMessage(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  content: string,
  files: File[],
): Promise<boolean | null> {
  localMessageSeq += 1;
  const seq = localMessageSeq;
  const message = buildOptimisticMessage(store.getState(), mode, scopeId, content, files, seq);
  store.dispatch({ type: "ADD_PENDING_MESSAGE", payload: { mode, scopeId, message } });

  try {
    const post = async (): Promise<PostMessageResponse> => {
      // RESET_SESSION removes all pending messages. Do not let an old queued
      // request start later under a newly authenticated browser session.
      if (!store.getState().pendingMessages.some((pending) => pending.id === message.id)) {
        throw new ApiRequestCancelledError();
      }
      let request: ApiOptions;
      if (files.length) {
        const form = new FormData();
        form.append("content", content);
        // Field name "files" (repeated, with filename); no Content-Type — the
        // browser sets the multipart boundary and api() leaves FormData headers alone.
        for (const file of files) form.append("files", file, file.name);
        request = { method: "POST", body: form };
      } else {
        request = { method: "POST", body: JSON.stringify({ content }) };
      }
      return runStatusMutation(store, mode, scopeId, () =>
        mode === "private"
          ? api<PostMessageResponse>(endpoints.postPrivateMessage.path(), request)
          : api<PostMessageResponse>(endpoints.postChannelMessage.path(scopeId), request),
      );
    };
    const result =
      mode === "private"
        ? await enqueuePrivatePost(store, scopeId, post)
        : await post();
    store.dispatch({
      type: "REPLACE_OPTIMISTIC_MESSAGE",
      payload: { mode, scopeId, tempId: message.id, saved: result.user_message ?? null },
    });
    // Channel behavior retains the immediate safety refresh. Private chat is
    // already updated by the POST plus its scope SSE; skipping a competing GET
    // here prevents a response from message N-1 from overwriting message N's
    // newer input-group status.
    if (mode === "channel") await refreshActiveChat(store);
    return true;
  } catch (error) {
    // A logout/account switch already reset the optimistic state. Do not put the
    // outgoing user's draft back into the newly active account.
    if (isApiRequestCancelled(error)) return null;
    store.dispatch({ type: "REMOVE_OPTIMISTIC_MESSAGE", payload: { mode, scopeId, tempId: message.id } });
    const text = error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: text });
    toast(text, { type: "error", title: t("chat.sendFailed") });
    return false;
  }
}

export async function respondAgentApproval(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  choice: AgentApprovalChoice,
): Promise<boolean> {
  try {
    await runStatusMutation(store, mode, scopeId, () =>
      mode === "private"
        ? api<AgentApprovalSubmitResponse>(endpoints.privateAgentApproval.path(), {
            method: "POST",
            body: JSON.stringify({ choice }),
          })
        : api<AgentApprovalSubmitResponse>(endpoints.channelAgentApproval.path(scopeId), {
            method: "POST",
            body: JSON.stringify({ choice }),
          }),
    );
    await refreshActiveChat(store);
    toast(t("chat.approvalSubmitted"), { type: "ok", title: t("chat.approvalProcessed") });
    return true;
  } catch (error) {
    if (isApiRequestCancelled(error)) return false;
    const text = error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: text });
    toast(text, { type: "error", title: t("chat.approvalFailed") });
    return false;
  }
}
