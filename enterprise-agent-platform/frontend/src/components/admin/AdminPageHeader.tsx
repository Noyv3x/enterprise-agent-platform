/* <AdminPageHeader/> — a restrained page title and description. Navigation
   position is intentionally omitted: the grouped admin navigation communicates
   hierarchy without a noisy 1/11 counter. */

import { Button, Space, Tooltip, Typography } from "antd";
import { useI18n } from "../../i18n";
import type { AdminPage } from "../../types";
import { Icon } from "../common/Icon";

export function AdminPageHeader({
  page,
  refreshing,
  onRefresh,
  refreshDisabled,
  onCreateAccount,
}: {
  page: AdminPage;
  refreshing: boolean;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  onCreateAccount?: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className={`eap-admin-page-header${onCreateAccount ? "" : " eap-admin-page-header--refresh-only"}`}>
      <div className="eap-admin-page-header__copy">
        <Typography.Title id={`admin-page-${page.id}-title`} level={2}>
          {t(`admin.page.${page.id}.label`)}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {t(`admin.page.${page.id}.description`)}
        </Typography.Paragraph>
      </div>
      <Space className="eap-admin-page-header__actions" wrap>
        {onCreateAccount ? (
          <Button type="primary" onClick={onCreateAccount} icon={<Icon name="plus" size={16} />}>
            {t("admin.accounts.create")}
          </Button>
        ) : null}
        <Tooltip title={t(refreshing ? "resource.refreshing" : "admin.common.refresh")}>
          <Button
            aria-label={t("admin.common.refresh")}
            icon={<Icon name="refresh" size={16} />}
            loading={refreshing}
            disabled={refreshDisabled}
            onClick={onRefresh}
          />
        </Tooltip>
      </Space>
    </header>
  );
}
