import {
  Avatar,
  Badge,
  Button,
  Dropdown,
  Form,
  Input,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
} from "antd";
import { useId, useRef, useState } from "react";
import { impersonateAccount, updateAccount } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { PermissionGroup, User } from "../../../types";
import { initials } from "../../../utils/format";
import { Drawer } from "../../common/Drawer";
import { Icon } from "../../common/Icon";
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
  const fieldId = (name: string) => `${formId}-${name}`;
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

  const handleSubmit = () => {
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
              loading={saving}
              disabled={!dirty}
            >
              {t("admin.accounts.save")}
            </Button>
          </Space>
        )}
      >
        <Form id={formId} className="eap-admin-account-form" layout="vertical" requiredMark={false} onFinish={handleSubmit}>
          <div className="eap-admin-account-form__identity">
            <Avatar size={40}>{initials(user.display_name || user.username)}</Avatar>
            <div>
              <Typography.Text strong>{user.username}</Typography.Text>
              <Typography.Text type="secondary">
                {permissionGroupLabel(t, user.permission_group || "member", user.permission_group_label)}
              </Typography.Text>
            </div>
          </div>
          <Form.Item label={t("admin.accounts.displayName")} htmlFor={fieldId("display-name")}>
            <Input id={fieldId("display-name")} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Form.Item>
          <Form.Item label={t("admin.accounts.position")} htmlFor={fieldId("position")}>
            <Input id={fieldId("position")} value={position} onChange={(event) => setPosition(event.target.value)} />
          </Form.Item>
          <Form.Item label={t("admin.accounts.permissionGroup")} htmlFor={fieldId("permission-group")}>
            <PermissionGroupSelect id={fieldId("permission-group")} groups={groups} value={permissionGroup} onChange={setPermissionGroup} />
          </Form.Item>
          <Form.Item label={t("admin.accounts.model")} htmlFor={fieldId("model")}>
            <AccountModelSelect id={fieldId("model")} value={modelName} onChange={setModelName} coercedRef={modelCoerced} />
          </Form.Item>
          <Form.Item label={t("admin.accounts.thinkingDepth")} htmlFor={fieldId("thinking-depth")}>
            <ThinkingDepthSelect id={fieldId("thinking-depth")} value={thinkingDepth} onChange={setThinkingDepth} />
          </Form.Item>
          <Form.Item label={t("admin.accounts.resetPassword")} htmlFor={fieldId("password")}>
            <Input.Password
              id={fieldId("password")}
              autoComplete="new-password"
              placeholder={t("admin.common.leaveBlank")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t("admin.accounts.enabled")} htmlFor={fieldId("enabled")} extra={t("admin.accounts.disabledHint")}>
            <Switch
              id={fieldId("enabled")}
              aria-label={t("admin.accounts.enabled")}
              checked={active}
              disabled={selfDisabled}
              onChange={setActive}
            />
          </Form.Item>
        </Form>
      </Drawer>
      {dialog}
    </>
  );
}

export function AccountIdentity({ user }: { user: User }) {
  return (
    <div className="eap-admin-account-identity">
      <Avatar size={36}>{initials(user.display_name || user.username)}</Avatar>
      <div>
        <Typography.Text strong ellipsis>{user.display_name || user.username}</Typography.Text>
        <Typography.Text type="secondary" ellipsis>
          @{user.username}{user.position ? ` · ${user.position}` : ""}
        </Typography.Text>
      </div>
    </div>
  );
}

export function AccountPermission({ user }: { user: User }) {
  const { t } = useI18n();
  return (
    <Tag className="eap-admin-account-permission" variant="filled">
      {permissionGroupLabel(t, user.permission_group || "member", user.permission_group_label)}
    </Tag>
  );
}

export function AccountModelPolicy({ user }: { user: User }) {
  const { t } = useI18n();
  const model = user.model_name || t("admin.model.systemDefault");
  return (
    <Tooltip title={model}>
      <Typography.Text className="eap-admin-account-model" type={user.model_name ? undefined : "secondary"} ellipsis>
        {model}
      </Typography.Text>
    </Tooltip>
  );
}

export function AccountStatus({ user }: { user: User }) {
  const { t } = useI18n();
  return (
    <Badge
      status={user.active ? "success" : "default"}
      text={t(user.active ? "admin.common.active" : "admin.common.disabled")}
    />
  );
}

export function AccountActions({ user, groups }: { user: User; groups: PermissionGroup[] }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const impersonating = useStore((state) => state.pendingOperations.includes(`admin:accounts:impersonate:${user.id}`));
  const currentUserId = useStore((state) => state.user?.id);
  const [editOpen, setEditOpen] = useState(false);
  const { confirm, dialog } = useConfirm();
  const selfDisabled = user.id === currentUserId;
  const canImpersonate = !selfDisabled && !!user.active;
  const impersonateDisabled = impersonating || !canImpersonate;

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
  const menuItems: MenuProps["items"] = [{
    key: "impersonate",
    label: t("admin.accounts.impersonate"),
    disabled: impersonateDisabled,
  }];
  return (
    <>
      <Space className="eap-admin-account-actions" size={4}>
        <Button type="text" size="small" icon={<Icon name="settings" size={15} />} onClick={() => setEditOpen(true)}>
          {t("admin.accounts.edit")}
        </Button>
        {canImpersonate ? (
          <Dropdown
            menu={{ items: menuItems, onClick: ({ key }) => key === "impersonate" && void handleImpersonate() }}
            placement="bottomRight"
            trigger={["click"]}
          >
            <Button type="text" size="small" loading={impersonating}>
              {t("admin.accounts.more")}
            </Button>
          </Dropdown>
        ) : null}
      </Space>
      {editOpen ? <AccountEditor user={user} groups={groups} open onClose={() => setEditOpen(false)} /> : null}
      {dialog}
    </>
  );
}

export function AccountMobileRow({ user, groups }: { user: User; groups: PermissionGroup[] }) {
  return (
    <article className="eap-admin-account-mobile-row">
      <div className="eap-admin-account-mobile-row__head">
        <AccountIdentity user={user} />
        <AccountStatus user={user} />
      </div>
      <div className="eap-admin-account-mobile-row__meta">
        <AccountPermission user={user} />
        <AccountModelPolicy user={user} />
      </div>
      <AccountActions user={user} groups={groups} />
    </article>
  );
}
