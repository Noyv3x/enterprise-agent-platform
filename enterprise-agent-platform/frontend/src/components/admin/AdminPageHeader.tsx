import { Button, Space } from "antd";
import { PageHeader } from "../ui/fieldwork";
import { useI18n } from "../../i18n";
import type { AdminPage } from "../../types";

export function AdminPageHeader({ page, refreshing, onRefresh, refreshDisabled, onCreateAccount }: {
  page: AdminPage; refreshing: boolean; onRefresh: () => void; refreshDisabled?: boolean; onCreateAccount?: () => void;
}) {
  const { t } = useI18n();
  return <PageHeader title={t(`admin.page.${page.id}.label`)} description={t(`admin.page.${page.id}.description`)}
    actions={<Space wrap>{onCreateAccount && <Button type="primary" onClick={onCreateAccount} disabled={refreshDisabled}>{t("admin.accounts.create")}</Button>}<Button onClick={onRefresh} loading={refreshing} disabled={refreshDisabled}>{t("admin.common.refresh")}</Button></Space>} />;
}
