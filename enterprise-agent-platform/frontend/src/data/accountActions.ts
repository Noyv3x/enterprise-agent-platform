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

export async function updateCurrentUser(
  store: AppStore,
  body: UpdateCurrentUserRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, async () => {
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
  await runBusy(store, async () => {
    const result = await api<ChangePasswordResponse>(endpoints.changePassword.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    store.dispatch({ type: "SET_USER", payload: result.user });
    onSuccess?.();
    toast(t("account.passwordUpdated"), { type: "ok", title: t("toast.complete") });
  });
}
