/* <AdminPageHeader/> — a restrained page title and description. Navigation
   position is intentionally omitted: the grouped admin navigation communicates
   hierarchy without a noisy 1/11 counter. */

import { useI18n } from "../../i18n";
import type { AdminPage } from "../../types";
import { Icon } from "../common/Icon";
import { LoadingButton } from "../common/LoadingButton";
import { PageHeader } from "../common/PageHeader";

export function AdminPageHeader({
  page,
  refreshing,
  onRefresh,
  refreshDisabled,
}: {
  page: AdminPage;
  refreshing: boolean;
  onRefresh: () => void;
  refreshDisabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <PageHeader
      className="admin-page__head"
      title={t(`admin.page.${page.id}.label`)}
      description={t(`admin.page.${page.id}.description`)}
      actions={(
        <LoadingButton
          className="btn--sm"
          loading={refreshing}
          disabled={refreshDisabled}
          loadingLabel={t("resource.refreshing")}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={15} />
          {t("admin.common.refresh")}
        </LoadingButton>
      )}
    />
  );
}
