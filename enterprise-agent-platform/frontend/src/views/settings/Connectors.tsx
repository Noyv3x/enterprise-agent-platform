import { useEffect, useId, useState, type ReactNode } from "react";
import { request, type McpConnectorList, type McpConnectorView, type McpDetectedFile } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { Switch } from "../../components/ui/beautiful/atoms/Switch";
import { EmptyState, Icon, Notice } from "../../components/ui/beautiful/controls";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { RecordStatus, RecordTag } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";
import { errorText, useResource } from "../admin/shared";
import { ConnectorSheet } from "../mcp/ConnectorSheet";
import { ImportDialog } from "../mcp/ImportDialog";
import { connectorDestination, STATUS_COLOR, useMcpLabels } from "../mcp/labels";

type Outcome = { tone: "success" | "danger"; text: string } | null;
const BASE = "/api/mcp/connectors";

/** Settings → Connectors: the organization connectors available to this account (connect, disconnect, the
 * account's own keys) and, when the permission group grants `install_extensions`, the account's own connectors
 * (add remote ones, and local programs for the personal AI; edit, enable, delete, per-tool switches). Config files
 * of other tools found in the personal workspace are offered for import, never enabled on their own. */
export function ConnectorSettings({ scope }: { scope: "private" | "chat" }) {
  const w = useWords();
  const labels = useMcpLabels();
  const list = useResource<McpConnectorList>(`${BASE}?scope=${scope}`);
  const [detected, setDetected] = useState<McpDetectedFile[]>([]);
  const [bannerHidden, setBannerHidden] = useState(false);
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [addedId, setAddedId] = useState<number | null>(null);
  const [importing, setImporting] = useState<{ path: string | null } | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const connectors = list.data?.connectors ?? [];
  const canInstall = list.data?.can_install === true;
  const allowLocal = scope === "private";
  const oauthWarning = list.data?.oauth_warning === "https_required";
  const org = connectors.filter((connector) => connector.scope === "org");
  const personal = connectors.filter((connector) => connector.scope === "personal");
  const opened = typeof openId === "number" ? connectors.find((connector) => connector.id === openId) ?? null : null;

  useEffect(() => {
    if (scope !== "private" || !canInstall) return;
    let current = true;
    request<{ files: McpDetectedFile[] }>("/api/mcp/import/detected")
      .then((result) => { if (current) setDetected(result.files); })
      .catch(() => undefined); // the offer is optional; the import dialog still accepts pasted text
    return () => { current = false; };
  }, [scope, canInstall]);

  // A sign-in finished in another tab (blocked popup) changes status; re-read when the page is shown again.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void list.reload(true); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [list.reload]);

  async function setEnabled(connector: McpConnectorView, enabled: boolean) {
    if (switching !== null) return;
    setSwitching(connector.id);
    setOutcome(null);
    try {
      await request(`${BASE}/${connector.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      await list.reload(true);
    } catch (cause) {
      setOutcome({ tone: "danger", text: errorText(cause) });
    } finally {
      setSwitching(null);
    }
  }

  if (list.state !== "ready") {
    return list.state === "loading"
      ? <LoadingState label={w("Loading connectors…", "正在加载连接器…", "正在載入連接器…")} />
      : <Notice tone="danger" title={w("Connectors could not be loaded", "无法加载连接器", "無法載入連接器")}
        action={<Button size="sm" className="touch:h-11" onClick={() => void list.reload()}>{w("Retry", "重试", "重試")}</Button>}>{list.error}</Notice>;
  }

  const add = <Button size="sm" variant="primary" className="touch:h-11 touch:px-4" onClick={() => { setOutcome(null); setOpenId("new"); }}>
    <Icon name="plus" size={14} />{w("Add connector", "添加连接器", "新增連接器")}
  </Button>;
  const importButton = <Button size="sm" variant="secondary" className="touch:h-11 touch:px-4" onClick={() => setImporting({ path: null })}>
    <Icon name="download" size={14} />{w("Import", "导入配置", "匯入設定")}
  </Button>;
  const quickAction = (connector: McpConnectorView) => {
    if (connector.status === "pending_confirmation") return connector.manageable ? w("Review", "查看并确认", "查看並確認") : null;
    if (!connector.enabled) return null;
    const own = connector.scope === "personal" || connector.credential_mode === "per_user";
    if (connector.status === "needs_auth" && connector.auth === "oauth" && own) return connector.last_error ? w("Re-authorize", "重新授权", "重新授權") : w("Connect", "连接", "連線");
    if (connector.status === "needs_secrets" && own) return w("Enter keys", "填写密钥", "填寫金鑰");
    return null;
  };
  const row = (connector: McpConnectorView) => {
    const action = quickAction(connector);
    const source = labels.source(connector);
    const name = connector.label || connector.name;
    return <li key={connector.id} className="flex items-center gap-2 border-b border-line py-1.5 pr-3 pl-1.5 transition-colors duration-100 last:border-0 hover:bg-inset sm:pr-4">
      <button type="button" onClick={() => { setOutcome(null); setOpenId(connector.id); }} className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-control px-2 py-1.5 text-left touch:min-h-11">
        <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{name}</span>
          <span className="font-mono text-[11.5px] text-ink-2">{connector.name}</span>
          {source && <RecordTag tag={source} />}
        </span>
        <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-2">
          <RecordStatus color={STATUS_COLOR[labels.tone(connector)]}>{labels.status(connector)}</RecordStatus>
          <span>{labels.transport(connector)}</span>
          {typeof connector.tool_count === "number" && <span className="tabular-nums">{w(`${connector.tool_count} tools`, `${connector.tool_count} 个工具`, `${connector.tool_count} 個工具`)}</span>}
        </span>
        {connector.status === "pending_confirmation" && <span className="flex max-w-full items-center gap-1.5 text-[12px] text-orange-ink">
          <Icon name="warning" size={12} strokeWidth={2} className="shrink-0" />
          <span className="min-w-0 truncate font-mono" title={connectorDestination(connector)}>{connectorDestination(connector)}</span>
        </span>}
        {connector.status === "error" && connector.last_error && <span className="line-clamp-1 max-w-full text-[12px] text-red-ink">{connector.last_error}</span>}
      </button>
      {action && <Button size="sm" variant="secondary" className="shrink-0 touch:h-11 touch:px-4" onClick={() => { setOutcome(null); setOpenId(connector.id); }}
        aria-label={`${action} · ${name}`}>{action}</Button>}
      {connector.scope === "personal" && connector.manageable && connector.status !== "pending_confirmation" && <span className="flex shrink-0 items-center pl-1 touch:min-h-11">
        <Switch checked={connector.enabled} disabled={switching !== null} onChange={(enabled) => void setEnabled(connector, enabled)} label={w(`Use ${name}`, `使用 ${name}`, `使用 ${name}`)} />
      </span>}
    </li>;
  };

  const showBanner = detected.length > 0 && !bannerHidden && canInstall;
  const showPersonal = canInstall || personal.length > 0;
  return <div className="flex flex-col gap-5">
    {canInstall && <div className="flex flex-wrap items-center justify-end gap-2">{importButton}{add}</div>}
    {!canInstall && <Notice tone="info" title={w("Your permission group cannot add connectors", "你的权限组不能添加连接器", "你的權限群組不能新增連接器")}>
      {w("You can still connect the organization's connectors below. Ask an administrator for “Install skills and connectors” to add your own.", "你仍然可以连接下面的组织连接器。如需添加自己的连接器，请联系管理员开通“安装技能和连接器”权限。", "你仍然可以連線下面的組織連接器。如需新增自己的連接器，請聯絡管理員開通「安裝技能和連接器」權限。")}
    </Notice>}
    {oauthWarning && connectors.some((connector) => connector.auth === "oauth") && <Notice tone="warning" title={labels.httpsWarning.title}>{labels.httpsWarning.body}</Notice>}
    {showBanner && <Notice tone="info" onDismiss={() => setBannerHidden(true)}
      title={w(`Found MCP settings from other tools in your workspace`, `在工作区发现其他工具的 MCP 配置`, `在工作區發現其他工具的 MCP 設定`)}
      action={<Button size="sm" variant="secondary" className="touch:h-11 touch:px-4" onClick={() => setImporting({ path: detected[0].path })}>{w("Review and import", "查看并导入", "查看並匯入")}</Button>}>
      <span className="font-mono text-[12px]">{detected.map((file) => file.path).join(", ")}</span>
      <span className="block">{w("Nothing is added until you import it.", "导入之前不会添加任何连接器。", "匯入之前不會新增任何連接器。")}</span>
    </Notice>}
    {outcome && !openId && <Notice tone={outcome.tone} title={outcome.text} onDismiss={() => setOutcome(null)} />}

    {showPersonal && <ConnectorGroup title={w("My connectors", "我的连接器", "我的連接器")} count={personal.length}
      hint={scope === "private" ? w("Only your own AI uses them.", "只有你自己的 AI 使用它们。", "只有你自己的 AI 使用它們。") : w("Remote ones are used in chat; local programs only by the personal AI.", "聊天中只使用远程连接器；本地程序只供个人 AI 使用。", "聊天中只使用遠端連接器；本機程式只供個人 AI 使用。")}
      empty={<EmptyState icon="globe" title={w("No connectors of your own yet", "还没有自己的连接器", "還沒有自己的連接器")}
        description={w("Add a service such as Notion or GitHub, import the setup you use in another AI tool, or ask your personal AI to add one.", "添加 Notion、GitHub 等服务，导入你在其他 AI 工具中的配置，或直接让个人 AI 帮你添加。", "新增 Notion、GitHub 等服務，匯入你在其他 AI 工具中的設定，或直接讓個人 AI 幫你新增。")}
        action={canInstall ? <>{importButton}{add}</> : undefined} />}>
      {personal.map(row)}
    </ConnectorGroup>}

    <ConnectorGroup title={w("Organization", "组织", "組織")} count={org.length}
      hint={w("Provided by your administrators for your permission group.", "管理员为你的权限组提供的连接器。", "管理員為你的權限群組提供的連接器。")}
      empty={w("No organization connectors yet. Connectors your administrators provide appear here.", "暂无组织连接器。管理员提供的连接器会显示在这里。", "尚無組織連接器。管理員提供的連接器會顯示在這裡。")}>
      {org.map(row)}
    </ConnectorGroup>

    {openId !== null && (openId === "new" || opened) && <ConnectorSheet
      key={openId}
      connector={opened}
      base={BASE}
      manageable={opened ? opened.manageable && canInstall : true}
      allowLocal={allowLocal}
      oauthWarning={oauthWarning}
      takenNames={personal.filter((connector) => connector.id !== opened?.id).map((connector) => connector.name)}
      onClose={() => { setOpenId(null); setAddedId(null); }}
      onRefresh={() => list.reload(true)}
      onCreated={(connector) => { setAddedId(connector.id); setOpenId(connector.id); }}
      justAdded={opened !== null && opened.id === addedId}
      onDeleted={(text) => { setOpenId(null); setOutcome({ tone: "success", text }); void list.reload(true); }}
    />}
    {importing && <ImportDialog open detected={detected} initialPath={importing.path}
      onClose={() => setImporting(null)}
      onImported={(result) => {
        void list.reload(true);
        const imported = result.connectors.map((connector) => connector.name);
        setDetected((files) => files.filter((file) => !file.servers.every((server) => imported.includes(server))));
      }} />}
  </div>;
}

function ConnectorGroup({ title, hint, count, empty, children }: { title: string; hint: string; count: number; empty: ReactNode; children: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
      <h2 id={id} className="text-[13px] font-medium text-ink">{title}</h2>
      <span className="text-[12px] text-ink-2 tabular-nums">{count}</span>
      <p className="basis-full text-[12px] leading-[1.4] text-ink-2 sm:ml-auto sm:basis-auto">{hint}</p>
    </div>
    {count > 0
      ? <ul className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">{children}</ul>
      : <div className="rounded-card bg-surface px-4 py-3 text-[12.5px] text-ink-2 shadow-card">{empty}</div>}
  </section>;
}
