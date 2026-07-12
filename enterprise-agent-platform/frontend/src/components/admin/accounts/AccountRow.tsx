/* <AccountRow/> — inline edit form for one account (legacy
   renderAccountRow, legacy-app.js:1483-1543). PUT /api/users/{id} (NOT PATCH).
   The "account enabled" checkbox is disabled for the current user (no
   self-disable). Password sent as "" when blank (= keep existing). On success the
   password field clears, users reload, toast.

   Controlled state preserves edits across re-renders (a deliberate improvement
   over the legacy full-teardown, which discarded unsaved edits on every render). */

import { useRef, useState } from "react";
import { impersonateAccount, updateAccount } from "../../../data/adminActions";
import { initials } from "../../../utils/format";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { PermissionGroup, User } from "../../../types";
import { Field } from "../../common/Field";
import { StatusBadge } from "../../common/StatusBadge";
import { AccountModelSelect } from "./AccountModelSelect";
import { PermissionGroupSelect, permissionGroupLabel } from "./PermissionGroupSelect";
import { ThinkingDepthSelect } from "./ThinkingDepthSelect";
import { useI18n } from "../../../i18n";

export function AccountRow({ user, groups }: { user: User; groups: PermissionGroup[] }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const currentUserId = useStore((state) => state.user?.id);

  const [displayName, setDisplayName] = useState(user.display_name || "");
  const [position, setPosition] = useState(user.position || "");
  const [permissionGroup, setPermissionGroup] = useState(user.permission_group || "member");
  const [modelName, setModelName] = useState(user.model_name || "");
  const [thinkingDepth, setThinkingDepth] = useState(user.thinking_depth || "medium");
  const [active, setActive] = useState(!!user.active);
  const [password, setPassword] = useState("");
  const modelCoerced = useRef(user.model_name || "");

  const selfDisabled = user.id === currentUserId;

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
      () => setPassword(""),
    );
  };

  const handleImpersonate = () => {
    void impersonateAccount(store, user.id);
  };

  return (
    <form className="account-row" onSubmit={handleSubmit}>
      <div className="account-row__head">
        <div className="account-row__identity">
          <div className="avatar">{initials(user.display_name || user.username)}</div>
          <div>
            <strong>{user.username}</strong>
            <span>{permissionGroupLabel(t, user.permission_group || "member", user.permission_group_label)}</span>
          </div>
        </div>
        <StatusBadge ok={!!user.active} label={t(user.active ? "admin.common.active" : "admin.common.disabled")} />
      </div>
      <div className="account-row__grid">
        <Field label={t("admin.accounts.displayName")}>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label={t("admin.accounts.position")}>
          <input
            value={position}
            placeholder={t("admin.accounts.position")}
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
        <Field label={t("admin.accounts.resetPassword")}>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("admin.common.leaveBlank")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <label className="check-row account-row__active">
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
      </div>
      <div className="form-actions">
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          disabled={busy || selfDisabled || !active}
          onClick={handleImpersonate}
          title={selfDisabled ? t("admin.accounts.impersonateCurrent") : active ? t("admin.accounts.impersonateTitle") : t("admin.accounts.impersonateDisabled")}
        >
          <span>{t("admin.accounts.impersonate")}</span>
        </button>
        <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>
          <span>{t("admin.accounts.save")}</span>
        </button>
      </div>
    </form>
  );
}
