/* =====================================================================
   Session lifecycle — boot / login / logout / handleSessionExpired / runBusy
   (legacy boot, logout, handleSessionExpired, withBusy; legacy-app.js:3431-3541).

   RESET_SESSION is centralized in resetSession(): it runs any registered
   teardown callbacks (Phase 3 registers SSE/poll close here), revokes all
   pending optimistic attachment blob URLs, then dispatches RESET_SESSION
   (which clears chat + admin + ui across the slice reducers). Both logout() and
   handleSessionExpired() route through it so the 401 path no longer leaks blobs.
   ===================================================================== */

import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { toast } from "../context/ToastContext";
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

function resetSession(store: AppStore): void {
  runSessionTeardowns();
  for (const message of store.getState().pendingMessages) revokeAttachmentUrls(message);
  store.dispatch({ type: "RESET_SESSION" });
}

/* ------------------------------------------------------------- lifecycle */

/** Called by api() on a 401 while we believed we were logged in: drop to login. */
export function handleSessionExpired(store: AppStore): void {
  if (!store.getState().user) return;
  resetSession(store);
  toast("会话已过期，请重新登录", { type: "error", title: "需要登录" });
}

export async function logout(store: AppStore): Promise<void> {
  await api(endpoints.logout.path(), { method: "POST" }).catch(() => {});
  resetSession(store);
}

/** The withBusy port: global busy flag + clear error; on throw store the error
 *  and toast it ONLY when logged in (login screen shows .error inline instead). */
export async function runBusy(store: AppStore, fn: () => Promise<void> | void): Promise<void> {
  store.dispatch({ type: "SET_BUSY", payload: true });
  store.dispatch({ type: "SET_ERROR", payload: "" });
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message || String(error) : String(error);
    store.dispatch({ type: "SET_ERROR", payload: message });
    if (store.getState().user) toast(message, { type: "error", title: "操作失败" });
  } finally {
    store.dispatch({ type: "SET_BUSY", payload: false });
  }
}

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
  store.dispatch({ type: "SET_USER", payload: result.user });
  await loadInitial(store);
  coerceActiveView(store);
}

/** Boot the session: probe /api/auth/me, hydrate, and coerce the view.
 *  The StrictMode-safe once-guard lives in <AppGate> (a useRef). */
export async function boot(store: AppStore): Promise<void> {
  try {
    const result = await api<AuthMeResponse>(endpoints.authMe.path());
    store.dispatch({ type: "SET_USER", payload: result.user });
    await loadInitial(store);
    coerceActiveView(store);
  } catch {
    store.dispatch({ type: "SET_USER", payload: null });
  }
}
