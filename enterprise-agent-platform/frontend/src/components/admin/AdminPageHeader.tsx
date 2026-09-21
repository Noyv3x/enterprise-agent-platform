import { Button } from "../ui/beautiful";
import { PageHeader } from "../ui/beautiful";
import { useI18n } from "../../i18n";
import type { AdminPage } from "../../types";

export function AdminPageHeader({ page, refreshing, onRefresh, refreshDisabled, onCreateAccount }: {
  page: AdminPage; refreshing: boolean; onRefresh: () => void; refreshDisabled?: boolean; onCreateAccount?: () => void;
}) {
  const { t } = useI18n();
  return <PageHeader title={t(`admin.page.${page.id}.label`)} description={t(`admin.page.${page.id}.description`)}
    actions={<div className="bui-actions">{onCreateAccount && <Button  variant="primary" onClick={onCreateAccount} disabled={refreshDisabled}>{t("admin.accounts.create")}</Button>}<Button onClick={onRefresh} loading={refreshing} disabled={refreshDisabled}>{t("admin.common.refresh")}</Button></div>} />;
}
