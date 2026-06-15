/* <RuntimeSettings/> — managed-runtime health board with per-row restart/refresh
   and a Hermes-only install action (legacy renderRuntimeSettings, legacy-app.js:
   2095-2128). Both actions POST the literal "{}" then reload ALL settings. The
   button label is "重启" only when managed && name!=="cognee", else "刷新" — but
   the endpoint is the same .../restart regardless. `runtimes === null` is the
   loading state. */

import { installHermes, restartRuntime } from "../../../data/adminActions";
import { cx } from "../../../lib/cx";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { RuntimeRow } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { StatusBadge } from "../../common/StatusBadge";

function RuntimeRowItem({ runtime, busy }: { runtime: RuntimeRow; busy: boolean }) {
  const store = useStoreHandle();
  const restartLabel = runtime.managed && runtime.name !== "cognee" ? "重启" : "刷新";
  return (
    <div className="runtime-row">
      <div className="runtime-row__main">
        <div className="runtime-row__title">
          <span className={cx("dot", runtime.available ? "dot--pulse" : "dot--off")} />
          <span className="runtime-row__name">{runtime.name}</span>
          <StatusBadge
            ok={!!runtime.available}
            label={runtime.state || (runtime.available ? "ready" : "down")}
          />
        </div>
        <div className="runtime-row__detail">
          {runtime.detail || runtime.error || runtime.path || ""}
        </div>
      </div>
      <div className="runtime-row__actions">
        {runtime.name === "hermes" ? (
          <button className="btn btn--sm" disabled={busy} onClick={() => void installHermes(store)}>
            <Icon name="download" size={14} />
            <span>安装</span>
          </button>
        ) : null}
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void restartRuntime(store, runtime.name)}
        >
          <Icon name="refresh" size={14} />
          <span>{restartLabel}</span>
        </button>
      </div>
    </div>
  );
}

export function RuntimeSettings() {
  const busy = useStore((state) => state.busy);
  const runtimes = useStore((state) => state.runtimes);

  return (
    <section className="card">
      <CardHead
        title="底层基座"
        icon="server"
        desc="平台托管的 Hermes / Cognee / Camofox / Firecrawl 运行时健康状态。"
      />
      <div className="list">
        {runtimes ? (
          Object.values(runtimes).map((runtime) => (
            <RuntimeRowItem key={runtime.name} runtime={runtime} busy={busy} />
          ))
        ) : (
          <div className="muted">正在读取运行时状态…</div>
        )}
      </div>
    </section>
  );
}
