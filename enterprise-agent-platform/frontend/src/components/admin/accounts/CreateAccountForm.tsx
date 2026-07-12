/* <CreateAccountForm/> — new-account form (legacy createForm in
   renderAccountManagement, legacy-app.js:1427-1471). POST /api/users with the
   exact JSON body; on success resets fields to defaults (member / medium / empty),
   reloads users, toasts. */

import { useRef, useState } from "react";
import { createAccount } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { PermissionGroup } from "../../../types";
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";
import { AccountModelSelect } from "./AccountModelSelect";
import { PermissionGroupSelect } from "./PermissionGroupSelect";
import { ThinkingDepthSelect } from "./ThinkingDepthSelect";

export function CreateAccountForm({ groups }: { groups: PermissionGroup[] }) {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [position, setPosition] = useState("");
  const [permissionGroup, setPermissionGroup] = useState("member");
  const [modelName, setModelName] = useState("");
  const [thinkingDepth, setThinkingDepth] = useState("medium");
  const modelCoerced = useRef("");

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
        setUsername("");
        setDisplayName("");
        setPassword("");
        setPosition("");
        setModelName("");
        setPermissionGroup("member");
        setThinkingDepth("medium");
      },
    );
  };

  return (
    <form className="account-create" onSubmit={handleSubmit}>
      <div className="account-create__grid">
        <Field label="用户名">
          <input
            placeholder="username"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="显示名称">
          <input
            placeholder="显示名称"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="初始密码">
          <input
            type="password"
            autoComplete="new-password"
            placeholder="初始密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="职位">
          <input
            placeholder="职位，例如 项目经理"
            value={position}
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
      </div>
      <button className="btn btn--primary" type="submit" disabled={busy}>
        <Icon name="plus" size={16} />
        <span>创建账户</span>
      </button>
    </form>
  );
}
