/* <CreateAccountForm/> — new-account form (legacy createForm in
   renderAccountManagement, legacy-app.js:1427-1471). POST /api/users with the
   exact JSON body; on success resets fields to defaults (member / medium / empty),
   reloads users, toasts. */

import { useId, useRef, useState } from "react";
import { createAccount } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { PermissionGroup } from "../../../types";
import { Field } from "../../common/Field";
import { Drawer } from "../../common/Drawer";
import { LoadingButton } from "../../common/LoadingButton";
import { useConfirm } from "../../../hooks/useConfirm";
import { AccountModelSelect } from "./AccountModelSelect";
import { PermissionGroupSelect } from "./PermissionGroupSelect";
import { ThinkingDepthSelect } from "./ThinkingDepthSelect";
import { useI18n } from "../../../i18n";

export function CreateAccountForm({
  groups,
  open,
  onClose,
}: {
  groups: PermissionGroup[];
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const creating = useStore((state) => state.pendingOperations.includes("admin:accounts:create"));

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [position, setPosition] = useState("");
  const [permissionGroup, setPermissionGroup] = useState("member");
  const [modelName, setModelName] = useState("");
  const [thinkingDepth, setThinkingDepth] = useState("medium");
  const modelCoerced = useRef("");
  const formId = useId();
  const { confirm, dialog } = useConfirm();

  const dirty = !!(
    username || displayName || password || position || permissionGroup !== "member" ||
    modelName || thinkingDepth !== "medium"
  );

  const reset = () => {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setPosition("");
    setModelName("");
    modelCoerced.current = "";
    setPermissionGroup("member");
    setThinkingDepth("medium");
  };

  const requestClose = async () => {
    if (dirty && !(await confirm(t("admin.accounts.discardCreate"), {
      title: t("admin.accounts.discardTitle"),
      confirmText: t("admin.accounts.discard"),
      danger: true,
    }))) return;
    reset();
    onClose();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void createAccount(
      store,
      {
        username,
        display_name: displayName,
        password,
        position,
        permission_group: permissionGroup,
        model_name: modelCoerced.current,
        thinking_depth: thinkingDepth,
      },
      () => {
        reset();
        onClose();
      },
    );
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={() => void requestClose()}
        title={t("admin.accounts.create")}
        description={t("admin.accounts.createDescription")}
        className="account-drawer"
        footer={(
          <>
            <button className="btn btn--ghost" type="button" onClick={() => void requestClose()}>
              {t("admin.common.cancel")}
            </button>
            <LoadingButton
              variant="primary"
              type="submit"
              form={formId}
              loading={creating}
              loadingLabel={t("admin.common.saving")}
              disabled={!dirty || !username.trim() || !password}
            >{t("admin.accounts.create")}</LoadingButton>
          </>
        )}
      >
        <form id={formId} className="account-drawer__form" onSubmit={handleSubmit}>
          <Field label={t("admin.accounts.username")}>
            <input
              placeholder={t("admin.accounts.usernamePlaceholder")}
              autoComplete="off"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label={t("admin.accounts.displayName")}>
            <input
              placeholder={t("admin.accounts.displayName")}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field label={t("admin.accounts.initialPassword")}>
            <input
              type="password"
              autoComplete="new-password"
              required
              placeholder={t("admin.accounts.initialPassword")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label={t("admin.accounts.position")}>
            <input
              placeholder={t("admin.accounts.positionPlaceholder")}
              value={position}
              onChange={(event) => setPosition(event.target.value)}
            />
          </Field>
          <Field label={t("admin.accounts.permissionGroup")}>
            <PermissionGroupSelect
              groups={groups}
              value={permissionGroup}
              onChange={setPermissionGroup}
            />
          </Field>
          <Field label={t("admin.accounts.model")}>
            <AccountModelSelect value={modelName} onChange={setModelName} coercedRef={modelCoerced} />
          </Field>
          <Field label={t("admin.accounts.thinkingDepth")}>
            <ThinkingDepthSelect value={thinkingDepth} onChange={setThinkingDepth} />
          </Field>
        </form>
      </Drawer>
      {dialog}
    </>
  );
}
