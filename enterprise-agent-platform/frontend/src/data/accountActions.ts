/* Current-user account settings actions. These intentionally do not use the
   admin account APIs, so members can update only their own profile/password. */

import { toast } from "../context/ToastContext";
import { t } from "../i18n";
import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  UpdateCurrentUserRequest,
  UpdateCurrentUserResponse,
} from "../types";
import { runBusy } from "./sessionActions";
import type { AppStore } from "./loaders";

const timezoneUpdates = new Map<string, Promise<void>>();

export function browserTimezone(): string {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim();
  } catch {
    return "";
  }
}

/** Persist a browser time zone only for a user that has never chosen one.
 * This is intentionally silent: first-run environment detection is not a
 * user-initiated profile mutation and should not raise a success toast. */
export function ensureCurrentUserTimezone(store: AppStore, userId: string | number, current: string | undefined): Promise<void> {
  if (String(current || "").trim()) return Promise.resolve();
  const timezone = browserTimezone();
  if (!timezone) return Promise.resolve();
  const key = `${userId}\u0000${timezone}`;
  const pending = timezoneUpdates.get(key);
  if (pending) return pending;
  const request = api<UpdateCurrentUserResponse>(endpoints.updateCurrentUser.path(), {
    method: "PUT",
    body: JSON.stringify({ timezone }),
  }).then((result) => {
    const latest = store.getState().user;
    if (String(latest?.id) === String(userId) && !String(latest?.timezone || "").trim()) {
      store.dispatch({ type: "SET_USER", payload: result.user });
    }
  }).finally(() => {
    timezoneUpdates.delete(key);
  });
  timezoneUpdates.set(key, request);
  return request;
}

export async function updateCurrentUser(
  store: AppStore,
  body: UpdateCurrentUserRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "account:profile", async () => {
    const result = await api<UpdateCurrentUserResponse>(endpoints.updateCurrentUser.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    store.dispatch({ type: "SET_USER", payload: result.user });
    onSuccess?.();
    toast(t("account.profileUpdated"), { type: "ok", title: t("toast.complete") });
  });
}

export async function changePassword(
  store: AppStore,
  body: ChangePasswordRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "account:password", async () => {
    const result = await api<ChangePasswordResponse>(endpoints.changePassword.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    store.dispatch({ type: "SET_USER", payload: result.user });
    onSuccess?.();
    toast(t("account.passwordUpdated"), { type: "ok", title: t("toast.complete") });
  });
}
