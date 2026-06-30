/* <AccountRow/> — inline edit form for one enterprise account (legacy
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
import { PermissionGroupSelect } from "./PermissionGroupSelect";
import { ThinkingDepthSelect } from "./ThinkingDepthSelect";

export function AccountRow({ user, groups }: { user: User; groups: PermissionGroup[] }) {
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
            <span>{user.permission_group_label || user.permission_group || "member"}</span>
          </div>
        </div>
        <StatusBadge ok={!!user.active} label={user.active ? "active" : "disabled"} />
      </div>
      <div className="account-row__grid">
        <Field label="显示名称">
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label="职位">
          <input
            value={position}
            placeholder="职位"
            onChange={(event) => setPosition(event.target.value)}
          />
        </Field>
        <Field label="权限组">
          <PermissionGroupSelect
            groups={groups}
            value={permissionGroup}
            onChange={setPermissionGroup}
          />
        </Field>
        <Field label="模型型号">
          <AccountModelSelect value={modelName} onChange={setModelName} coercedRef={modelCoerced} />
        </Field>
        <Field label="思考深度">
          <ThinkingDepthSelect value={thinkingDepth} onChange={setThinkingDepth} />
        </Field>
        <Field label="重置密码">
          <input
            type="password"
            autoComplete="new-password"
            placeholder="留空不修改"
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
            <strong>账户启用</strong>
            <span>停用后无法登录</span>
          </div>
        </label>
      </div>
      <div className="form-actions">
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          disabled={busy || selfDisabled || !active}
          onClick={handleImpersonate}
          title={selfDisabled ? "当前已是此账号" : active ? "以此账号登录" : "账号已停用"}
        >
          <span>管理员代入</span>
        </button>
        <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>
          <span>保存账户</span>
        </button>
      </div>
    </form>
  );
}
