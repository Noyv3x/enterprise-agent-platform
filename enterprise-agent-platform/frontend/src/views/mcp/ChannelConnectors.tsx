import { useId, useState } from "react";
import { request, type McpChannelConnectors } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { Switch } from "../../components/ui/beautiful/atoms/Switch";
import { Notice } from "../../components/ui/beautiful/controls";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { RecordStatus } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";
import { errorText, useResource } from "../admin/shared";
import { STATUS_COLOR, useMcpLabels } from "./labels";

/** A channel's 连接器: the organization connectors with shared credentials it may use, each switched on for the
 * channel explicitly by someone who manages channels. Personal and per-user connectors never reach a channel. */
export function ChannelConnectors({ channelId }: { channelId: number }) {
  const w = useWords();
  const labels = useMcpLabels();
  const headingId = useId();
  const path = `/api/channels/${channelId}/mcp`;
  const data = useResource<McpChannelConnectors>(path);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function toggle(id: number, enabled: boolean) {
    if (!data.data || saving) return;
    const current = data.data.connector_ids;
    const connectorIds = enabled ? [...current, id] : current.filter((item) => item !== id);
    setSaving(true);
    setError("");
    try {
      data.setData(await request<McpChannelConnectors>(path, { method: "PUT", body: JSON.stringify({ connector_ids: connectorIds }) }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section aria-labelledby={headingId} className="mt-6 flex flex-col gap-3 border-t border-line pt-5">
    <div>
      <h3 id={headingId} className="text-[13px] font-medium text-ink">{w("Connectors", "连接器", "連接器")}</h3>
      <p className="mt-0.5 text-[12px] leading-[1.45] text-ink-2">{w("Services the channel agent may use, with the organization's shared account, for everyone in the channel. Switches apply right away.", "频道 Agent 可以使用的服务，使用组织的共享账号，频道里的每个人都可以让 Agent 使用。开关立即生效。", "頻道 Agent 可以使用的服務，使用組織的共用帳號，頻道裡的每個人都可以讓 Agent 使用。開關立即生效。")}</p>
    </div>
    {error && <Notice tone="danger" title={w("The change was not saved", "更改未保存", "變更未儲存")} onDismiss={() => setError("")}>{error}</Notice>}
    {data.state === "loading" ? <LoadingState label={w("Loading connectors…", "正在加载连接器…", "正在載入連接器…")} />
      : data.state === "error" || !data.data ? <Notice tone="danger" title={w("Connectors could not be loaded", "无法加载连接器", "無法載入連接器")}
        action={<Button size="sm" className="touch:h-11" onClick={() => void data.reload()}>{w("Retry", "重试", "重試")}</Button>}>{data.error}</Notice>
      : data.data.connectors.length === 0
        ? <p className="rounded-card bg-inset px-3 py-2.5 text-[12.5px] leading-[1.45] text-ink-2">{w("No connectors can be used in channels yet. An administrator can add one with shared credentials in Administration → Connectors.", "暂无可在频道中使用的连接器。管理员可以在“管理 → 连接器”中添加使用共享凭据的连接器。", "尚無可在頻道中使用的連接器。管理員可以在「管理 → 連接器」中新增使用共用憑證的連接器。")}</p>
        : <ul className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
          {data.data.connectors.map((connector) => {
            const name = connector.label || connector.name;
            return <li key={connector.id} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">{name}</span>
                  <span className="font-mono text-[11.5px] text-ink-2">{connector.name}</span>
                </div>
                <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-2">
                  <RecordStatus color={STATUS_COLOR[labels.tone(connector)]}>{labels.status(connector)}</RecordStatus>
                  {connector.origin && <span className="min-w-0 truncate font-mono">{connector.origin}</span>}
                </span>
              </div>
              <span className="flex shrink-0 items-center touch:min-h-11">
                <Switch checked={data.data?.connector_ids.includes(connector.id) ?? false} disabled={saving} onChange={(enabled) => void toggle(connector.id, enabled)}
                  label={w(`Use ${name} in this channel`, `在此频道使用 ${name}`, `在此頻道使用 ${name}`)} />
              </span>
            </li>;
          })}
        </ul>}
  </section>;
}
