/* <CreateAccountForm/> — new-account form (legacy createForm in
   renderAccountManagement, legacy-app.js:1427-1471). POST /api/users with the
   exact JSON body; on success resets fields to defaults (member / medium / empty),
   reloads users, toasts. */

import { Button, Form, Input, Space } from "antd";
import { useId, useRef, useState } from "react";
import { createAccount } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { PermissionGroup } from "../../../types";
import { Drawer } from "../../common/Drawer";
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
  const fieldId = (name: string) => `${formId}-${name}`;
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

  const handleSubmit = () => {
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
        className="account-drawer eap-admin-account-drawer"
        footer={(
          <Space>
            <Button type="text" onClick={() => void requestClose()}>
              {t("admin.common.cancel")}
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              form={formId}
              loading={creating}
              disabled={!dirty || !username.trim() || !password}
            >{t("admin.accounts.create")}</Button>
          </Space>
        )}
      >
        <Form id={formId} className="eap-admin-account-form" layout="vertical" requiredMark={false} onFinish={handleSubmit}>
          <Form.Item label={t("admin.accounts.username")} htmlFor={fieldId("username")} required>
            <Input
              id={fieldId("username")}
              placeholder={t("admin.accounts.usernamePlaceholder")}
              autoComplete="off"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t("admin.accounts.displayName")} htmlFor={fieldId("display-name")}>
            <Input
              id={fieldId("display-name")}
              placeholder={t("admin.accounts.displayName")}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t("admin.accounts.initialPassword")} htmlFor={fieldId("password")} required>
            <Input.Password
              id={fieldId("password")}
              autoComplete="new-password"
              required
              placeholder={t("admin.accounts.initialPassword")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t("admin.accounts.position")} htmlFor={fieldId("position")}>
            <Input
              id={fieldId("position")}
              placeholder={t("admin.accounts.positionPlaceholder")}
              value={position}
              onChange={(event) => setPosition(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t("admin.accounts.permissionGroup")} htmlFor={fieldId("permission-group")}>
            <PermissionGroupSelect
              id={fieldId("permission-group")}
              groups={groups}
              value={permissionGroup}
              onChange={setPermissionGroup}
            />
          </Form.Item>
          <Form.Item label={t("admin.accounts.model")} htmlFor={fieldId("model")}>
            <AccountModelSelect id={fieldId("model")} value={modelName} onChange={setModelName} coercedRef={modelCoerced} />
          </Form.Item>
          <Form.Item label={t("admin.accounts.thinkingDepth")} htmlFor={fieldId("thinking-depth")}>
            <ThinkingDepthSelect id={fieldId("thinking-depth")} value={thinkingDepth} onChange={setThinkingDepth} />
          </Form.Item>
        </Form>
      </Drawer>
      {dialog}
    </>
  );
}
