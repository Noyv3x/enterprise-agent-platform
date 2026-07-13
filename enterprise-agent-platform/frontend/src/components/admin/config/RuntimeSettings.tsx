/* Managed-runtime health board with per-row restart or refresh actions. */

import { restartRuntime } from "../../../data/adminActions";
import { cx } from "../../../lib/cx";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { RuntimeRow } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { LoadingButton } from "../../common/LoadingButton";
import { StatusBadge } from "../../common/StatusBadge";
import { useI18n, type Translator } from "../../../i18n";

function runtimeStateLabel(t: Translator, state: string | undefined, available: boolean): string {
  switch (String(state || "").toLowerCase()) {
    case "ready": case "running": return t("admin.runtime.ready");
    case "down": case "stopped": return t("admin.runtime.down");
    case "starting": return t("admin.runtime.starting");
    case "error": case "failed": return t("admin.runtime.error");
    case "external": return t("admin.runtime.external");
    case "prepared": return t("admin.runtime.prepared");
    case "missing": return t("admin.runtime.missing");
    case "degraded": return t("admin.runtime.degraded");
    case "installed": return t("admin.runtime.installed");
    case "install_failed": return t("admin.runtime.installFailed");
    case "invalid_config": return t("admin.runtime.invalidConfig");
    default: return state || t(available ? "admin.runtime.ready" : "admin.runtime.down");
  }
}

function RuntimeRowItem({ runtime }: { runtime: RuntimeRow }) {
  const store = useStoreHandle();
  const { t } = useI18n();
  const restarting = useStore((state) =>
    state.pendingOperations.includes(`admin:runtime:restart:${runtime.name}`),
  );
  const restartLabel = t(runtime.managed && runtime.name !== "cognee" ? "admin.runtime.restart" : "admin.common.refresh");
  const restartLoadingLabel = t(
    runtime.managed && runtime.name !== "cognee"
      ? "admin.common.restarting"
      : "resource.refreshing",
  );
  return (
    <div className="runtime-row">
      <div className="runtime-row__main">
        <div className="runtime-row__title">
          <span className={cx("dot", runtime.available ? "dot--pulse" : "dot--off")} />
          <span className="runtime-row__name">
            {runtime.name === "agent" ? t("admin.runtime.agentName") : runtime.name}
          </span>
          <StatusBadge
            ok={!!runtime.available}
            label={runtimeStateLabel(t, runtime.state, !!runtime.available)}
          />
        </div>
        <div className="runtime-row__detail">
          {runtime.detail || runtime.error || runtime.path || ""}
        </div>
      </div>
      <div className="runtime-row__actions">
        <LoadingButton
          className="btn--sm"
          loading={restarting}
          loadingLabel={restartLoadingLabel}
          onClick={() => void restartRuntime(store, runtime.name)}
        >
          <Icon name="refresh" size={14} />
          <span>{restartLabel}</span>
        </LoadingButton>
      </div>
    </div>
  );
}

export function RuntimeSettings() {
  const { t } = useI18n();
  const runtimes = useStore((state) => state.runtimes);

  return (
    <section className="card">
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
    </section>
  );
}
