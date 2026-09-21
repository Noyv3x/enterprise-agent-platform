import { useI18n } from "../../../i18n";
import { useStore } from "../../../store/useStore";
import { formatTimestamp } from "../../../utils/format";
import { EmptyState, Notice, ResourceList, ResourceRow, Section, StatusMark } from "../../ui/beautiful";

export function RuntimeSettings() {
  const { t } = useI18n();
  const runtimes = useStore((state) => state.runtimes);
  const rows = Object.entries(runtimes || {});
  return <Section title={t("admin.runtime.title")} description={t("admin.runtime.description")}>
    {rows.length ? <ResourceList>{rows.map(([id, runtime]) => {
      const ready = runtime.available === true && (runtime.state === "running" || runtime.state === "available");
      const status = ready ? t("admin.runtime.ready") : runtime.state === "error" ? t("admin.runtime.error") : runtime.state === "missing" ? t("admin.runtime.missing") : runtime.state === "invalid_config" ? t("admin.runtime.invalidConfig") : t("admin.runtime.down");
      return <ResourceRow key={id} title={runtime.name === "agent" ? t("admin.runtime.agentName") : runtime.name === "searxng" ? t("admin.runtime.searxngName") : runtime.name || id}
        status={<StatusMark tone={ready ? "success" : "warning"}>{status}</StatusMark>}
        description={runtime.detail || undefined}
        meta={runtime.status_checked_at ? t("admin.oauth.updatedAt", { time: formatTimestamp(runtime.status_checked_at) }) : undefined}>
        {runtime.status_stale && <StatusMark tone="neutral">{t("admin.runtime.stale")}</StatusMark>}
        {runtime.error && <Notice tone="danger" title={runtime.error} />}
      </ResourceRow>;
    })}</ResourceList> : <EmptyState title={t("admin.runtime.down")} compact />}
  </Section>;
}
