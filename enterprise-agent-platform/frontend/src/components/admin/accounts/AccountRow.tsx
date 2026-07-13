/* Compact account summary with an on-demand editor. Keeping forms out of the
   list makes large directories scannable and prevents unrelated fields from
   competing for attention. */

import { useId, useRef, useState } from "react";
import { impersonateAccount, updateAccount } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { PermissionGroup, User } from "../../../types";
import { initials } from "../../../utils/format";
import { Drawer } from "../../common/Drawer";
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";
import { LoadingButton } from "../../common/LoadingButton";
import { StatusBadge } from "../../common/StatusBadge";
import { AccountModelSelect } from "./AccountModelSelect";
import { PermissionGroupSelect, permissionGroupLabel } from "./PermissionGroupSelect";
import { ThinkingDepthSelect } from "./ThinkingDepthSelect";

interface AccountEditorProps {
  user: User;
  groups: PermissionGroup[];
  open: boolean;
  onClose: () => void;
}

function AccountEditor({ user, groups, open, onClose }: AccountEditorProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const saving = useStore((state) => state.pendingOperations.includes(`admin:accounts:update:${user.id}`));
  const currentUserId = useStore((state) => state.user?.id);
  const [displayName, setDisplayName] = useState(user.display_name || "");
  const [position, setPosition] = useState(user.position || "");
  const [permissionGroup, setPermissionGroup] = useState(user.permission_group || "member");
  const [modelName, setModelName] = useState(user.model_name || "");
  const [thinkingDepth, setThinkingDepth] = useState(user.thinking_depth || "medium");
  const [active, setActive] = useState(!!user.active);
  const [password, setPassword] = useState("");
  const modelCoerced = useRef(user.model_name || "");
  const formId = useId();
  const { confirm, dialog } = useConfirm();
  const selfDisabled = user.id === currentUserId;

  const dirty =
    displayName !== (user.display_name || "") ||
    position !== (user.position || "") ||
    permissionGroup !== (user.permission_group || "member") ||
    modelName !== (user.model_name || "") ||
    thinkingDepth !== (user.thinking_depth || "medium") ||
    active !== !!user.active ||
    !!password;

  const requestClose = async () => {
    if (dirty && !(await confirm(t("admin.accounts.discardEdit"), {
      title: t("admin.accounts.discardTitle"),
      confirmText: t("admin.accounts.discard"),
      danger: true,
    }))) return;
    onClose();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void updateAccount(
      store,
      user.id,
      user.username,
      {
        display_name: displayName,
        position,
        permission_group: permissionGroup,
        model_name: modelCoerced.current,
        thinking_depth: thinkingDepth,
        active,
        password,
      },
      onClose,
    );
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={() => void requestClose()}
        title={t("admin.accounts.editTitle", { username: user.username })}
        description={t("admin.accounts.editDescription")}
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
              loading={saving}
              loadingLabel={t("admin.common.saving")}
              disabled={!dirty}
            >{t("admin.accounts.save")}</LoadingButton>
          </>
        )}
      >
        <form id={formId} className="account-drawer__form" onSubmit={handleSubmit}>
          <div className="account-drawer__identity">
            <div className="avatar">{initials(user.display_name || user.username)}</div>
            <div>
              <strong>{user.username}</strong>
              <span>{permissionGroupLabel(t, user.permission_group || "member", user.permission_group_label)}</span>
            </div>
          </div>
          <Field label={t("admin.accounts.displayName")}>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label={t("admin.accounts.position")}>
            <input value={position} onChange={(event) => setPosition(event.target.value)} />
          </Field>
          <Field label={t("admin.accounts.permissionGroup")}>
            <PermissionGroupSelect groups={groups} value={permissionGroup} onChange={setPermissionGroup} />
          </Field>
          <Field label={t("admin.accounts.model")}>
            <AccountModelSelect value={modelName} onChange={setModelName} coercedRef={modelCoerced} />
          </Field>
          <Field label={t("admin.accounts.thinkingDepth")}>
            <ThinkingDepthSelect value={thinkingDepth} onChange={setThinkingDepth} />
          </Field>
          <Field label={t("admin.accounts.resetPassword")}>
            <input
              type="password"
              autoComplete="new-password"
              placeholder={t("admin.common.leaveBlank")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={active}
              disabled={selfDisabled}
              onChange={(event) => setActive(event.target.checked)}
            />
            <div className="check-row__text">
              <strong>{t("admin.accounts.enabled")}</strong>
              <span>{t("admin.accounts.disabledHint")}</span>
            </div>
          </label>
        </form>
      </Drawer>
      {dialog}
    </>
  );
}

export function AccountRow({ user, groups }: { user: User; groups: PermissionGroup[] }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const impersonating = useStore((state) => state.pendingOperations.includes(`admin:accounts:impersonate:${user.id}`));
  const currentUserId = useStore((state) => state.user?.id);
  const [editOpen, setEditOpen] = useState(false);
  const { confirm, dialog } = useConfirm();
  const selfDisabled = user.id === currentUserId;
  const groupLabel = permissionGroupLabel(t, user.permission_group || "member", user.permission_group_label);

  const handleImpersonate = async () => {
    const ok = await confirm(
      t("admin.accounts.impersonateConfirm", { name: user.display_name || user.username }),
      {
        title: t("admin.accounts.impersonateConfirmTitle"),
        confirmText: t("admin.accounts.impersonateConfirmAction"),
      },
    );
    if (ok) await impersonateAccount(store, user.id);
  };

  return (
    <article className="account-row">
      <div className="account-row__identity">
        <div className="avatar">{initials(user.display_name || user.username)}</div>
        <div>
          <strong>{user.display_name || user.username}</strong>
          <span>@{user.username}{user.position ? ` · ${user.position}` : ""}</span>
        </div>
      </div>
      <div className="account-row__meta">
        <span>{groupLabel}</span>
        <span>{user.model_name || t("admin.model.systemDefault")}</span>
      </div>
      <StatusBadge ok={!!user.active} label={t(user.active ? "admin.common.active" : "admin.common.disabled")} />
      <div className="account-row__actions">
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          disabled={impersonating || selfDisabled || !user.active}
          onClick={() => void handleImpersonate()}
          title={selfDisabled ? t("admin.accounts.impersonateCurrent") : user.active ? t("admin.accounts.impersonateTitle") : t("admin.accounts.impersonateDisabled")}
        >
          {t("admin.accounts.impersonate")}
        </button>
        <button className="btn btn--ghost btn--sm" type="button" onClick={() => setEditOpen(true)}>
          <Icon name="settings" size={15} />
          {t("admin.accounts.edit")}
        </button>
      </div>
      {editOpen ? (
        <AccountEditor user={user} groups={groups} open onClose={() => setEditOpen(false)} />
      ) : null}
      {dialog}
    </article>
  );
}
