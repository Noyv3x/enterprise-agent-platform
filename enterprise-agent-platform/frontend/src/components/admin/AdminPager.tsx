import { SectionIndex } from "../ui/beautiful";
import { selectAdminPage } from "../../data/adminActions";
import { useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import type { AdminPageId } from "../../types";

const ADMIN_PAGE_GROUPS: ReadonlyArray<{ id: "people" | "agents" | "system"; pages: readonly AdminPageId[] }> = [
  { id: "people", pages: ["accounts", "tokens", "messages"] },
  { id: "agents", pages: ["agent-runtime", "telegram"] },
  { id: "system", pages: ["updates", "branding", "security", "runtime", "secrets"] },
];

export function AdminPager({ activeId }: { activeId: AdminPageId }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  return <SectionIndex label={t("admin.pager.ariaLabel")} activeKey={activeId}
    groups={ADMIN_PAGE_GROUPS.map((group) => ({ key: group.id, label: t(`admin.group.${group.id}`), items: group.pages.map((id) => ({ key: id, label: t(`admin.page.${id}.label`) })) }))}
    onSelect={(id) => { void selectAdminPage(store, id as AdminPageId); }} />;
}
