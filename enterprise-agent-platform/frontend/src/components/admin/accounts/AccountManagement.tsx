import { Table, Typography, type TableProps } from "antd";
import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { FALLBACK_PERMISSION_GROUPS } from "../../../lib/constants";
import { useStore } from "../../../store/useStore";
import type { User } from "../../../types";
import { CreateAccountForm } from "./CreateAccountForm";
import {
  AccountActions,
  AccountIdentity,
  AccountMobileRow,
  AccountModelPolicy,
  AccountPermission,
  AccountStatus,
} from "./AccountRow";

/** Structured account data: compact table on wide containers, list on phones. */
export function AccountManagement({
  createOpen,
  onCloseCreate,
}: {
  createOpen: boolean;
  onCloseCreate: () => void;
}) {
  const { t } = useI18n();
  const permissionGroups = useStore((state) => state.permissionGroups);
  const users = useStore((state) => state.users);
  const containerRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<"table" | "list">("table");
  const groups = permissionGroups.length ? permissionGroups : FALLBACK_PERMISSION_GROUPS;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === "undefined") {
      const width = container.getBoundingClientRect().width;
      setLayout((width > 0 ? width < 840 : window.matchMedia("(max-width: 1100px)").matches) ? "list" : "table");
      return;
    }
    const update = (width: number) => {
      if (width > 0) setLayout(width < 840 ? "list" : "table");
    };
    update(container.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const columns: TableProps<User>["columns"] = [
    {
      title: t("admin.accounts.column.account"),
      key: "account",
      render: (_, user) => <AccountIdentity user={user} />,
    },
    {
      title: t("admin.accounts.column.permission"),
      key: "permission",
      width: 150,
      render: (_, user) => <AccountPermission user={user} />,
    },
    {
      title: t("admin.accounts.column.model"),
      key: "model",
      width: 220,
      render: (_, user) => <AccountModelPolicy user={user} />,
    },
    {
      title: t("admin.accounts.column.status"),
      key: "status",
      width: 118,
      render: (_, user) => <AccountStatus user={user} />,
    },
    {
      title: t("admin.accounts.column.actions"),
      key: "actions",
      width: 158,
      align: "right",
      render: (_, user) => <AccountActions user={user} groups={groups} />,
    },
  ];

  return (
    <section ref={containerRef} className="eap-admin-accounts" aria-label={t("admin.accounts.title")}>
      <div className="eap-admin-accounts__meta">
        <Typography.Text type="secondary">
          {t("admin.accounts.count", { count: users.length })}
        </Typography.Text>
      </div>
      {layout === "table" ? (
        <Table<User>
          className="eap-admin-account-table"
          columns={columns}
          dataSource={users}
          rowKey={(user) => String(user.id)}
          pagination={false}
          size="middle"
          tableLayout="fixed"
          scroll={{ x: 820 }}
          locale={{ emptyText: t("admin.accounts.empty") }}
        />
      ) : null}
      {layout === "list" ? (
        <div className="eap-admin-account-list">
          {users.length ? (
            users.map((user) => <AccountMobileRow key={String(user.id)} user={user} groups={groups} />)
          ) : (
            <Typography.Text type="secondary">{t("admin.accounts.empty")}</Typography.Text>
          )}
        </div>
      ) : null}
      <CreateAccountForm groups={groups} open={createOpen} onClose={onCloseCreate} />
    </section>
  );
}
