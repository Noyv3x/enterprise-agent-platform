/* =====================================================================
   Session lifecycle — boot / login / logout / handleSessionExpired / runBusy
   (legacy boot, logout, handleSessionExpired, withBusy; legacy-app.js:3431-3541).

   RESET_SESSION is centralized in resetSession(): it runs any registered
   teardown callbacks (Phase 3 registers SSE/poll close here), revokes all
   pending optimistic attachment blob URLs, then dispatches RESET_SESSION
   (which clears chat + admin + ui across the slice reducers). Both logout() and
   handleSessionExpired() route through it so the 401 path no longer leaks blobs.
   ===================================================================== */

import { api, isApiError, isApiRequestCancelled, resetApiSession } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { toast } from "../context/ToastContext";
import { t } from "../i18n";
import { hasPermission, isAdmin } from "../store/selectors";
import { revokeAttachmentUrls } from "../utils/composerFiles";
import type { ActiveView, AuthMeResponse, LoginResponse } from "../types";
import { loadInitial, type AppStore } from "./loaders";

/* ------------------------------------------------ session teardown registry */

type SessionTeardown = () => void;

const sessionTeardowns = new Set<SessionTeardown>();

/** Register a callback (e.g. close SSE / stop the poll) to run on every session
 *  reset. Returns an unregister fn. Phase 3 realtime hooks use this. */
export function registerSessionTeardown(fn: SessionTeardown): () => void {
  sessionTeardowns.add(fn);
  return () => {
    sessionTeardowns.delete(fn);
  };
}

function runSessionTeardowns(): void {
  for (const fn of [...sessionTeardowns]) {
    try {
      fn();
    } catch {
      /* teardown is best-effort; never let one failure block the rest */
    }
  }
}

export function resetSession(
  store: AppStore,
  { preservePendingOperations = false }: { preservePendingOperations?: boolean } = {},
): void {
  const pendingOperations = preservePendingOperations
    ? [...store.getState().pendingOperations]
    : [];
  resetApiSession();
  runSessionTeardowns();
  for (const message of store.getState().pendingMessages) revokeAttachmentUrls(message);
  store.dispatch({ type: "RESET_SESSION" });
  for (const operationId of pendingOperations) {
    store.dispatch({ type: "BEGIN_BUSY", payload: operationId });
  }
}

/* ------------------------------------------------------------- lifecycle */

/** Called by api() on a 401 while we believed we were logged in: drop to login. */
export function handleSessionExpired(store: AppStore): void {
  if (!store.getState().user) return;
  resetSession(store);
  toast(t("session.expired"), { type: "error", title: t("session.loginRequired") });
}

export function logout(store: AppStore): Promise<void> {
  // Treat the click as the local session boundary immediately: sensitive state
  // disappears and all requests owned by the outgoing account are invalidated
  // before the best-effort server notification starts.
  resetSession(store);
  return api(endpoints.logout.path(), {
    method: "POST",
    keepalive: true,
    skipAuthHandling: true,
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** The withBusy port: global busy flag + clear error; on throw store the error
 *  and toast it ONLY when logged in (login screen shows .error inline instead). */
export async function runBusy(
  store: AppStore,
  operationKeyOrFn: string | (() => Promise<void> | void),
  maybeFn?: () => Promise<void> | void,
): Promise<void> {
  const operationId =
    typeof operationKeyOrFn === "string"
      ? operationKeyOrFn
      : `operation-${++busyOperationSequence}`;
  const fn = typeof operationKeyOrFn === "string" ? maybeFn : operationKeyOrFn;
  if (!fn) throw new Error(`Missing operation callback for ${operationId}`);
  if (
    typeof operationKeyOrFn === "string" &&
    store.getState().pendingOperations.includes(operationId)
  ) {
    return;
  }
  store.dispatch({ type: "BEGIN_BUSY", payload: operationId });
  store.dispatch({ type: "SET_ERROR", payload: "" });
  try {
    await fn();
  } catch (error) {
    if (isApiRequestCancelled(error)) return;
    const message = error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: message });
    if (store.getState().user) {
      toast(message, { type: "error", title: t("toast.operationFailed") });
    }
  } finally {
    store.dispatch({ type: "END_BUSY", payload: operationId });
  }
}

let busyOperationSequence = 0;

/** Coerce the active view if the user lacks permission for it
 *  (legacy renderShell guard, legacy-app.js:408-409). */
function coerceActiveView(store: AppStore): void {
  const state = store.getState();
  let view: ActiveView = state.activeView;
  if (!isAdmin(state) && view === "admin") view = "channel";
  if (!hasPermission(state, "private_agent") && view === "private") view = "channel";
  if (view !== state.activeView) store.dispatch({ type: "SET_ACTIVE_VIEW", payload: view });
}

export async function login(store: AppStore, username: string, password: string): Promise<void> {
  const result = await api<LoginResponse>(endpoints.login.path(), {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  resetSession(store, { preservePendingOperations: true });
  store.dispatch({ type: "SET_USER", payload: result.user });
  await loadInitial(store);
  coerceActiveView(store);
}

/** Boot the session: probe /api/auth/me, hydrate, and coerce the view.
 *  The StrictMode-safe once-guard lives in <AppGate> (a useRef). */
export type BootResult = "authenticated" | "anonymous" | "error";

export async function boot(store: AppStore): Promise<BootResult> {
  try {
    const result = await api<AuthMeResponse>(endpoints.authMe.path(), { skipAuthHandling: true });
    store.dispatch({ type: "SET_USER", payload: result.user });
    await loadInitial(store);
    coerceActiveView(store);
    return "authenticated";
  } catch (error) {
    const result = isApiError(error, 401) || isApiRequestCancelled(error) ? "anonymous" : "error";
    resetSession(store);
    return result;
  }
}
