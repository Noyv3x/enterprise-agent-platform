import { Button, Dropdown } from "antd";
import { useState } from "react";
import { impersonateAccount } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { permissionGroupLabel } from "../../../i18n/labels";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { User } from "../../../types";
import { DataRegion, EmptyState, ResourceList, ResourceRow, StatusMark } from "../../ui/fieldwork";
import { AccountEditor } from "./AccountEditor";

export function AccountManagement({ createOpen, onCloseCreate }: { createOpen: boolean; onCloseCreate: () => void }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const users = useStore((state) => state.users);
  const groups = useStore((state) => state.permissionGroups);
  const currentId = useStore((state) => state.user?.id);
  const pending = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:accounts:")));
  const [editing, setEditing] = useState<User | null>(null);
  const { confirm, dialog } = useConfirm();
  const impersonate = async (user: User) => {
    if (!(await confirm(t("admin.accounts.impersonateConfirm", { name: user.display_name || user.username }), { title: t("admin.accounts.impersonateConfirmTitle"), confirmText: t("admin.accounts.impersonateConfirmAction"), danger: true }))) return;
    if (store.getState().user?.id !== currentId || store.getState().pendingOperations.some((key) => key.startsWith("admin:accounts:"))) return;
    void impersonateAccount(store, user.id);
  };
  return <section aria-label={t("admin.accounts.title")}>{dialog}
    <p>{t("admin.accounts.count", { count: users.length })}</p>
    <DataRegion state={users.length ? "ready" : "empty"} loadingLabel={t("common.loading")} empty={<EmptyState title={t("admin.accounts.empty")} compact />}>
      <ResourceList label={t("admin.accounts.title")}>{users.map((user) => <ResourceRow key={user.id}
        title={user.display_name || user.username} description={`@${user.username}${user.position?.trim() ? ` · ${user.position.trim()}` : ""}`}
        status={<StatusMark tone={user.active ? "success" : "neutral"}>{t(user.active ? "admin.common.active" : "admin.common.disabled")}</StatusMark>}
        meta={<>{permissionGroupLabel(t, user.permission_group || "", groups.find((group) => group.id === user.permission_group)?.label || user.permission_group_label)} · {user.model_name || t("admin.model.systemDefault")}</>}
        actions={<div className="wf-account-actions"><Button onClick={() => setEditing(user)} disabled={pending}>{t("admin.accounts.edit")}</Button>{user.active && user.id !== currentId && <Dropdown menu={{ items: [{ key: "impersonate", label: t("admin.accounts.impersonate"), danger: true, onClick: () => { void impersonate(user); } }] }} trigger={["click"]}><Button disabled={pending}>{t("admin.accounts.more")}</Button></Dropdown>}</div>} />)}</ResourceList>
    </DataRegion>
    {createOpen && <AccountEditor key="create" onClose={onCloseCreate} />}
    {editing && <AccountEditor key={String(editing.id)} user={editing} onClose={() => setEditing(null)} />}
  </section>;
}
