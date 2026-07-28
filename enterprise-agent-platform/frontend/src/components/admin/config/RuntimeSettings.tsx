/* Read-only health board; service lifecycle is owned exclusively by Manager. */

import { Badge } from "antd";
import { cx } from "../../../lib/cx";
import { useStore } from "../../../store/useStore";
import type { RuntimeRow } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { AdminCard } from "../AdminCard";
import { useI18n, type Translator } from "../../../i18n";

function runtimeStateLabel(t: Translator, state: RuntimeRow["state"]): string {
  switch (state) {
    case "running":
    case "available":
      return t("admin.runtime.ready");
    case "unavailable":
      return t("admin.runtime.down");
    case "error":
      return t("admin.runtime.error");
    case "missing": return t("admin.runtime.missing");
    case "invalid_config": return t("admin.runtime.invalidConfig");
  }
}

function runtimeNameLabel(t: Translator, name: string): string {
  switch (name) {
    case "agent":
      return t("admin.runtime.agentName");
    case "searxng":
      return t("admin.runtime.searxngName");
    default:
      return name;
  }
}

function RuntimeRowItem({ runtime }: { runtime: RuntimeRow }) {
  const { t } = useI18n();
  return (
    <div className="runtime-row">
      <div className="runtime-row__main">
        <div className="runtime-row__title">
          <span className={cx("dot", runtime.available ? "dot--pulse" : "dot--off")} />
          <span className="runtime-row__name">
            {runtimeNameLabel(t, runtime.name)}
          </span>
          <Badge
            className="status"
            status={runtime.available ? "success" : "warning"}
            text={runtimeStateLabel(t, runtime.state)}
          />
        </div>
        <div className="runtime-row__detail">
          {runtime.detail || runtime.error}
        </div>
      </div>
    </div>
  );
}

export function RuntimeSettings() {
  const { t } = useI18n();
  const runtimes = useStore((state) => state.runtimes);

  return (
    <AdminCard>
      <CardHead
        title={t("admin.runtime.title")}
        icon="server"
        desc={t("admin.runtime.description")}
      />
      <div className="list">
        {runtimes ? (
          Object.values(runtimes).map((runtime) => (
            <RuntimeRowItem key={runtime.name} runtime={runtime} />
          ))
        ) : (
          <div className="muted">{t("admin.runtime.loading")}</div>
        )}
      </div>
    </AdminCard>
  );
}
