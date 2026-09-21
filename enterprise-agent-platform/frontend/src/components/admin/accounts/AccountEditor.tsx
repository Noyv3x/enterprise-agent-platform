import { Button, Form, Input, Switch } from "antd";
import { useId, useState } from "react";
import { createAccount, updateAccount } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { User } from "../../../types";
import { Drawer } from "../../common/Drawer";
import { FormFooter, FormGrid, Notice, Section } from "../../ui/fieldwork";
import { AccountModelSelect } from "./AccountModelSelect";
import { PermissionGroupSelect } from "./PermissionGroupSelect";
import { ThinkingDepthSelect } from "./ThinkingDepthSelect";

export function AccountEditor({ user, onClose }: { user?: User; onClose: () => void }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const groups = useStore((state) => state.permissionGroups);
  const currentId = useStore((state) => state.user?.id);
  const saving = useStore((state) => state.pendingOperations.includes(user ? `admin:accounts:update:${user.id}` : "admin:accounts:create"));
  const [initial] = useState(() => ({ username: user?.username || "", display_name: user?.display_name || "", position: user?.position || "", permission_group: user?.permission_group || "member", model_name: user?.model_name || "", thinking_depth: user?.thinking_depth || "medium", password: "", active: user ? !!user.active : true }));
  const [draft, setDraft] = useState(initial);
  const formId = useId();
  const field = (name: string) => `${formId}-${name}`;
  const change = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const dirty = Object.keys(initial).some((key) => draft[key as keyof typeof draft] !== initial[key as keyof typeof initial]);
  const { confirm, dialog } = useConfirm();
  const close = async () => {
    if (saving) return;
    if (dirty && !(await confirm(t(user ? "admin.accounts.discardEdit" : "admin.accounts.discardCreate"), { title: t("admin.accounts.discardTitle"), confirmText: t("admin.accounts.discard"), danger: true }))) return;
    onClose();
  };
  const submit = () => {
    if (saving || !dirty || (!user && (!draft.username.trim() || !draft.password))) return;
    const { username, ...body } = draft;
    if (user) void updateAccount(store, user.id, user.username, body, onClose);
    else {
      const { active: _active, ...createBody } = body;
      void createAccount(store, { username, ...createBody }, onClose);
    }
  };
  return <>{dialog}<Drawer open onClose={() => { void close(); }} title={user ? t("admin.accounts.editTitle", { username: user.username }) : t("admin.accounts.create")}
    description={t(user ? "admin.accounts.editDescription" : "admin.accounts.createDescription")}
    footer={<FormFooter><Button onClick={() => { void close(); }} disabled={saving}>{t("admin.common.cancel")}</Button><Button type="primary" htmlType="submit" form={formId} loading={saving} disabled={!dirty || (!user && (!draft.username.trim() || !draft.password))}>{t(user ? "admin.accounts.save" : "admin.accounts.create")}</Button></FormFooter>}>
    <Form id={formId} layout="vertical" onFinish={submit} disabled={saving} className="wf-account-fields">
      <Section title={t("admin.accounts.identity")}><FormGrid>
        <Form.Item label={t("admin.accounts.username")} htmlFor={field("username")}><Input id={field("username")} value={draft.username} readOnly={!!user} autoComplete="off" maxLength={40} onChange={(e) => change("username", e.target.value)} /></Form.Item>
        <Form.Item label={t("admin.accounts.displayName")} htmlFor={field("display_name")}><Input id={field("display_name")} value={draft.display_name} onChange={(e) => change("display_name", e.target.value)} /></Form.Item>
        <Form.Item label={t("admin.accounts.position")} htmlFor={field("position")}><Input id={field("position")} value={draft.position} maxLength={80} onChange={(e) => change("position", e.target.value)} /></Form.Item>
      </FormGrid></Section>
      <Section title={t("admin.accounts.access")}><FormGrid>
        <Form.Item label={t("admin.accounts.permissionGroup")} htmlFor={field("permission_group")}><PermissionGroupSelect id={field("permission_group")} groups={groups} value={draft.permission_group} onChange={(v) => change("permission_group", v)} /></Form.Item>
        {user && <Form.Item label={t("admin.accounts.enabled")} htmlFor={field("active" )} help={t("admin.accounts.disabledHint")}><Switch id={field("active")} checked={draft.active} disabled={saving || user.id === currentId} onChange={(v) => change("active", v)} /></Form.Item>}
      </FormGrid></Section>
      <Section title={t("admin.accounts.column.model")}><FormGrid>
        <Form.Item label={t("admin.accounts.model")} htmlFor={field("model")}><AccountModelSelect id={field("model")} value={draft.model_name} onChange={(v) => change("model_name", v)} /></Form.Item>
        <Form.Item label={t("admin.accounts.thinkingDepth")} htmlFor={field("depth")}><ThinkingDepthSelect id={field("depth")} value={draft.thinking_depth} onChange={(v) => change("thinking_depth", v)} /></Form.Item>
      </FormGrid></Section>
      <Section title={t("admin.accounts.credentials")}><Notice tone="info" title={t("admin.accounts.credentialNotice")} />
        <Form.Item label={t(user ? "admin.accounts.resetPassword" : "admin.accounts.initialPassword")} htmlFor={field("password")} help={user ? t("admin.common.leaveBlank") : undefined}><Input.Password id={field("password")} value={draft.password} autoComplete="new-password" onChange={(e) => change("password", e.target.value)} /></Form.Item>
      </Section>
    </Form>
  </Drawer></>;
}
