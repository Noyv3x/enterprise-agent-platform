/* Chat navigation, realtime refresh, approvals and optimistic sends. */

import {
  api,
  apiUpload,
  ApiRequestCancelledError,
  getApiSessionGeneration,
  isApiError,
  isApiRequestCancelled,
  type ApiOptions,
  type ApiUploadProgress,
} from "../lib/api";
import { EMPTY_BODY, endpoints } from "../lib/endpoints";
import { toast } from "../context/ToastContext";
import { t } from "../i18n";
import { scopeIdFor, scopeTypeFor } from "../store/selectors";
import { optimisticAttachments } from "../utils/composerFiles";
import {
  cacheVisibleChat,
  chatScopeKey,
  restoreCachedChat,
  upsertCachedMessage,
} from "./chatCache";
import { ensureResource, resourceKeys, runResourceLoad } from "./resourceState";
import { ensureAdminPageResource } from "./adminResources";
import {
  beginStatusMutation,
  finishStatusMutation,
  invalidateStatusReads,
  isStatusMutationCurrent,
  isScopeReadCurrent,
  isStatusReadCurrent,
  issueStatusRead,
} from "./statusFence";
import { applyAgentStatus, applyMessageResponse } from "./messageSync";
import { isChannelUnavailable, removeUnavailableChannel } from "./channelLifecycle";
import {
  loadChannelMessages,
  loadChannels,
  loadPrivateMessages,
  loadPrivateTelegram,
  type AppStore,
} from "./loaders";
import type {
  ActiveView,
  AgentApprovalChoice,
  AgentApprovalRequest,
  AgentApprovalSubmitRequest,
  AgentApprovalSubmitResponse,
  AgentStatus,
  AgentSessionCompactResponse,
  AppState,
  ChannelMessagesResponse,
  ChannelDeleteResponse,
  ChatMode,
  Id,
  Message,
  PostMessageResponse,
  PrivateMessagesResponse,
  TypingUser,
  WithdrawChannelMessageResponse,
} from "../types";

export async function compactAgentSession(
  mode: ChatMode,
  scopeId: string,
): Promise<AgentSessionCompactResponse> {
  return await api<AgentSessionCompactResponse>(
    endpoints.compactAgentSession.path(),
    {
      method: "POST",
      body: JSON.stringify({ scope_type: mode, scope_id: String(scopeId) }),
    },
  );
}

/* Cross-source re-entrancy mutex: SSE update handlers and the safety poll both
   call refreshActiveChat and must not
   overlap. */
let pollInFlight = false;
let pendingRefresh: {
  store: AppStore;
  authoritativeStatus: boolean;
  actorId: Id;
  generation: number;
} | null = null;


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

/** The active scope's SSE URL. */
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

function messageSyncPath(
  path: string,
  state: AppState,
  mode: ChatMode,
  scopeId: string,
): string {
  const params = new URLSearchParams();
  const cursor = state.messageSyncCursors[chatScopeKey(mode, scopeId)];
  if (cursor) {
    params.set("after_id", cursor.afterId);
    params.set("since_revision", String(cursor.revision));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function canRefreshCachedScope(
  state: AppState,
  mode: ChatMode,
  scopeId: string,
): boolean {
  const cursor = state.messageSyncCursors[chatScopeKey(mode, scopeId)];
  return cursor?.afterId !== undefined && cursor.revision !== undefined;
}

async function loadNavigatedChat(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  restored: boolean,
  loadFullPage: () => Promise<void>,
  refreshRelated?: () => Promise<void>,
): Promise<void> {
  // A restored cache can contain several history pages. Refresh it from its
  // forward cursor so returning to the scope cannot replace that history with
  // the server's unparameterized latest page.
  if (restored && canRefreshCachedScope(store.getState(), mode, scopeId)) {
    await Promise.all([
      refreshActiveChat(store),
      refreshRelated?.() ?? Promise.resolve(),
    ]);
    return;
  }
  await loadFullPage();
}


export interface ScopeRealtimeUpdate {
  agent_status?: AgentStatus | null;
  typing?: TypingUser[];
  message_revision?: string | number;
  revision?: string | number;
  latest_message_id?: Id | null;
}

/** Apply cheap SSE state directly and report whether persisted messages changed. */
export function applyScopeRealtimeUpdate(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  update: ScopeRealtimeUpdate,
): boolean {
  if (mode === "channel" && isChannelUnavailable(store, scopeId)) return false;
  if (mode === "private" && String(store.getState().user?.id) !== scopeId) return false;
  if (update.agent_status) {
    // An SSE snapshot is newer than any status GET already in flight. Invalidate
    // those reads before applying it so an equal-second watchdog response
    // cannot authoritatively roll the status back.
    invalidateStatusReads(store, mode, scopeId);
  }
  applyAgentStatus(store, mode, scopeId, update.agent_status);
  const state = store.getState();
  if (
    mode === "channel" &&
    String(state.activeChannelId) === scopeId &&
    Array.isArray(update.typing) &&
    (
      update.typing.length !== state.typingUsers.length ||
      update.typing.some((item, index) => (
        String(item.user_id ?? "") !== String(state.typingUsers[index]?.user_id ?? "") ||
        String(item.username ?? "") !== String(state.typingUsers[index]?.username ?? "")
      ))
    )
  ) {
    store.dispatch({ type: "SET_TYPING_USERS", payload: update.typing });
  }
  const revision = update.message_revision ?? update.revision;
  const cursor = state.messageSyncCursors[chatScopeKey(mode, scopeId)];
  const currentRevision = cursor?.revision;
  const revisionChanged = revision !== undefined &&
    (currentRevision === undefined || String(revision) !== String(currentRevision));
  const remoteLatest = update.latest_message_id == null ||
    String(update.latest_message_id) === "0"
    ? ""
    : String(update.latest_message_id);
  const latestChanged = update.latest_message_id != null &&
    remoteLatest !== (cursor?.afterId === "0" ? "" : cursor?.afterId ?? "");
  return revisionChanged || latestChanged;
}

/** Best-effort active-scope synchronization; explicit actions surface errors. */
export async function refreshActiveChat(
  store: AppStore,
  { authoritativeStatus = true }: { authoritativeStatus?: boolean } = {},
): Promise<void> {
  const initial = store.getState();
  if (!initial.user) return;
  const generation = getApiSessionGeneration();
  if (pollInFlight) {
    // Slow links can leave an older GET in flight when SSE announces a newer
    // revision. Coalesce follow-up triggers, but never discard the newest one:
    // run it immediately after the current request settles.
    pendingRefresh = { store, authoritativeStatus, actorId: initial.user.id, generation };
    return;
  }
  const mode = scopeModeFor(initial.activeView);
  if (!mode) return;
  if (mode === "channel" && !initial.activeChannelId) return;
  if (mode === "channel" && isChannelUnavailable(store, initial.activeChannelId!)) return;

  pollInFlight = true;
  try {
    const scopeId = mode === "channel"
      ? String(initial.activeChannelId)
      : scopeIdFor(initial, "private");
    const statusRead = issueStatusRead(store, mode, scopeId);
    const path = mode === "channel"
      ? endpoints.channelMessages.path(scopeId)
      : endpoints.privateMessages.path();
    const result = await api<ChannelMessagesResponse | PrivateMessagesResponse>(
      messageSyncPath(path, initial, mode, scopeId),
    );
    if (mode === "channel" && String(store.getState().activeChannelId) !== scopeId) return;
    if (!isScopeReadCurrent(statusRead)) return;
    applyMessageResponse(
      store, mode, scopeId, result, isStatusReadCurrent(statusRead), authoritativeStatus,
    );
  } catch (error) {
    if (
      mode === "channel"
      && generation === getApiSessionGeneration()
      && String(store.getState().user?.id) === String(initial.user.id)
      && (isApiError(error, 403) || isApiError(error, 404))
    ) {
      await removeUnavailableChannel(store, initial.activeChannelId!);
      // Navigation can await another scope's loader. Never start this refresh
      // under a different account after that await.
      if (
        generation === getApiSessionGeneration()
        && String(store.getState().user?.id) === String(initial.user.id)
      ) await loadChannels(store).catch(() => undefined);
    }
    // Other polling/SSE failures are best-effort.
  } finally {
    pollInFlight = false;
    const next = pendingRefresh;
    pendingRefresh = null;
    if (
      next
      && next.generation === getApiSessionGeneration()
      && String(next.store.getState().user?.id) === String(next.actorId)
    ) {
      void refreshActiveChat(next.store, {
        authoritativeStatus: next.authoritativeStatus,
      });
    }
  }
}

/* ---------------------------------------------------------- nav -> loader */

/** Switch the workspace view, close the drawer, then fire the view's loader.
 *  Channel view loads via
 *  selectChannel / existing state, so it has no loader here. */
export async function navigateToView(store: AppStore, view: ActiveView): Promise<void> {
  cacheVisibleChat(store);
  store.dispatch({ type: "SET_ACTIVE_VIEW", payload: view });
  store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
  if (view !== "private") {
    store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false });
  }
  if (view === "private") {
    const scopeId = scopeIdFor(store.getState(), "private");
    const restored = restoreCachedChat(store, "private", scopeId);
    await runResourceLoad(store, resourceKeys.privateChat, () => loadNavigatedChat(
      store,
      "private",
      scopeId,
      restored,
      () => loadPrivateMessages(store),
      () => loadPrivateTelegram(store),
    ));
  } else if (view === "admin") {
    await ensureAdminPageResource(store, store.getState().activeAdminPage);
  }
}

/** Select a channel, close the drawer, then load its messages. */
export async function selectChannel(store: AppStore, channelId: Id): Promise<void> {
  if (!store.getState().user || isChannelUnavailable(store, channelId)) return;
  cacheVisibleChat(store);
  store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "channel" });
  store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: channelId });
  const scopeId = String(channelId);
  const restored = restoreCachedChat(store, "channel", scopeId);
  if (!restored) {
    store.dispatch({ type: "SET_MESSAGES", payload: [] });
  }
  store.dispatch({ type: "SET_TYPING_USERS", payload: [] });
  store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
  store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false });
  await runResourceLoad(store, resourceKeys.channelChat(channelId), () => loadNavigatedChat(
    store,
    "channel",
    scopeId,
    restored,
    () => loadChannelMessages(store),
  ));
}

/** Archive access and confirm runtime cleanup; a partial cleanup remains retryable. */
export async function deleteChannel(store: AppStore, channelId: Id): Promise<boolean> {
  const actorId = store.getState().user?.id;
  const generation = getApiSessionGeneration();
  if (actorId == null) return false;
  const current = () => generation === getApiSessionGeneration()
    && String(store.getState().user?.id) === String(actorId);
  try {
    const result = await api<ChannelDeleteResponse>(
      endpoints.deleteChannel.path(channelId),
      { method: "DELETE", body: EMPTY_BODY },
    );
    if (!current()) return false;
    if (result.deleted !== true || String(result.channel_id) !== String(channelId)) {
      throw new Error(t("nav.channel.deleteFailed"));
    }
    await removeUnavailableChannel(store, channelId);
    if (!current()) return false;
    toast(t("nav.channel.deleteSuccess"), { type: "ok" });
    return true;
  } catch (error) {
    if (!current() || isApiRequestCancelled(error)) return false;
    // A 503 may mean archival committed but process cleanup did not. Refresh
    // availability, without turning the failed cleanup into reported success.
    if (isApiError(error, 503) || isApiError(error, 403) || isApiError(error, 404)) {
      await loadChannels(store).catch(() => undefined);
      if (!current()) return false;
    }
    const text = error instanceof Error ? error.message : String(error);
    store.dispatch({ type: "SET_ERROR", payload: text });
    toast(text, { type: "error", title: t("nav.channel.deleteFailed") });
    return false;
  }
}

/* ----------------------------------------------------- optimistic send */

/* Monotonic counter for optimistic temporary ids and attachment ids. */
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

/** Build the optimistic user message. optimisticAttachments mints blob: preview
 *  URLs that are revoked in the slice's
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
    metadata: {
      local_pending: true,
      ...(files.length
        ? {
            upload: {
              state: "queued" as const,
              loaded: 0,
              total: files.reduce((sum, file) => sum + file.size, 0),
              percent: 0,
            },
          }
        : {}),
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** The core send mutation: optimistic insert -> POST (multipart with files, else
 *  JSON {content}) -> replace temp with the
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
  const actorId = store.getState().user?.id;
  const generation = getApiSessionGeneration();
  const current = () => actorId != null
    && generation === getApiSessionGeneration()
    && String(store.getState().user?.id) === String(actorId)
    && (mode !== "channel" || !isChannelUnavailable(store, scopeId));
  if (!current()) return null;
  localMessageSeq += 1;
  const seq = localMessageSeq;
  const message = buildOptimisticMessage(store.getState(), mode, scopeId, content, files, seq);
  store.dispatch({ type: "ADD_PENDING_MESSAGE", payload: { mode, scopeId, message } });

  const updateUpload = (
    state: "queued" | "uploading" | "processing",
    progress?: ApiUploadProgress,
  ) => {
    if (!files.length || !current()) return;
    const fallbackTotal = files.reduce((sum, file) => sum + file.size, 0);
    const total = Math.max(0, progress?.total || fallbackTotal);
    const loaded = state === "processing"
      ? total
      : Math.max(0, Math.min(progress?.loaded || 0, total));
    const percent = state === "processing"
      ? 100
      : total > 0
        ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
        : 0;
    store.dispatch({
      type: "UPDATE_OPTIMISTIC_UPLOAD",
      payload: {
        tempId: message.id,
        upload: { state, loaded, total, percent },
      },
    });
  };

  try {
    const post = async (): Promise<PostMessageResponse> => {
      // RESET_SESSION removes all pending messages. Do not let an old queued
      // request start later under a newly authenticated browser session.
      if (!current() || !store.getState().pendingMessages.some((pending) => pending.id === message.id)) {
        throw new ApiRequestCancelledError();
      }
      if (files.length) {
        const form = new FormData();
        form.append("content", content);
        // Field name "files" (repeated, with filename); no Content-Type — the
        // browser sets the multipart boundary and api() leaves FormData headers alone.
        for (const file of files) form.append("files", file, file.name);
        updateUpload("uploading");
        const path = mode === "private"
          ? endpoints.postPrivateMessage.path()
          : endpoints.postChannelMessage.path(scopeId);
        return runStatusMutation(store, mode, scopeId, () =>
          apiUpload<PostMessageResponse>(path, form, {
            onProgress: (progress) => updateUpload("uploading", progress),
            onUploadComplete: () => updateUpload("processing"),
          }),
        );
      }
      const request: ApiOptions = { method: "POST", body: JSON.stringify({ content }) };
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
    if (!current()) return null;
    store.dispatch({
      type: "REPLACE_OPTIMISTIC_MESSAGE",
      payload: { mode, scopeId, tempId: message.id, saved: result.user_message ?? null },
    });
    upsertCachedMessage(store, mode, scopeId, result.user_message);
    // Channel behavior retains the immediate safety refresh. Private chat is
    // already updated by the POST plus its scope SSE; skipping a competing GET
    // here prevents a response from message N-1 from overwriting message N's
    // newer input-group status.
    if (mode === "channel") await refreshActiveChat(store);
    return true;
  } catch (error) {
    // A logout/account switch already reset the optimistic state. Do not put the
    // outgoing user's draft back into the newly active account.
    if (!current() || isApiRequestCancelled(error)) return null;
    store.dispatch({ type: "REMOVE_OPTIMISTIC_MESSAGE", payload: { mode, scopeId, tempId: message.id } });
    const text = error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: text });
    toast(text, { type: "error", title: t("chat.sendFailed") });
    return false;
  }
}

/** Withdraw one server-persisted message owned by the current channel user. */
export async function withdrawChannelMessage(
  store: AppStore,
  channelId: string,
  messageId: Id,
): Promise<boolean> {
  try {
    await api<WithdrawChannelMessageResponse>(
      endpoints.withdrawChannelMessage.path(channelId, messageId),
      { method: "DELETE", body: EMPTY_BODY },
    );
    const state = store.getState();
    if (
      state.activeView === "channel" &&
      String(state.activeChannelId) === String(channelId)
    ) {
      store.dispatch({
        type: "SET_MESSAGES",
        payload: state.messages.filter(
          (message) => String(message.id) !== String(messageId),
        ),
      });
      cacheVisibleChat(store);
      await refreshActiveChat(store);
    }
    toast(t("chat.withdraw.success"), {
      type: "ok",
      title: t("chat.withdraw.successTitle"),
    });
    return true;
  } catch (error) {
    if (isApiRequestCancelled(error)) return false;
    const text = error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: text });
    toast(text, { type: "error", title: t("chat.withdraw.failed") });
    return false;
  }
}

/** Answer the approval the user is looking at. The request carries that exact
 *  `run_id`/`approval_id`; a 409 means the Platform no longer holds this item as
 *  the scope's pending approval, so the gesture is dropped and the scope is
 *  resynchronized instead of being applied to whatever is pending now. */
export async function respondAgentApproval(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  approval: AgentApprovalRequest,
  choice: AgentApprovalChoice,
): Promise<boolean> {
  const body: AgentApprovalSubmitRequest = {
    choice,
    run_id: String(approval.run_id || ""),
    approval_id: String(approval.approval_id || ""),
  };
  try {
    await runStatusMutation(store, mode, scopeId, () =>
      api<AgentApprovalSubmitResponse>(
        mode === "private"
          ? endpoints.privateAgentApproval.path()
          : endpoints.channelAgentApproval.path(scopeId),
        { method: "POST", body: JSON.stringify(body) },
      ),
    );
    await refreshActiveChat(store);
    toast(t("chat.approvalSubmitted"), { type: "ok", title: t("chat.approvalProcessed") });
    return true;
  } catch (error) {
    if (isApiRequestCancelled(error)) return false;
    const outdated = isApiError(error, 409);
    if (outdated) await refreshActiveChat(store);
    const text = outdated
      ? t("chat.approvalOutdated")
      : error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: text });
    toast(text, { type: "error", title: t("chat.approvalFailed") });
    return false;
  }
}
