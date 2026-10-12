import { useEffect, useId, useState } from "react";
import { ApiError, request, type McpAdminConnector, type McpCatalog, type McpConnectorView, type McpTestResult } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import { Switch } from "../../components/ui/beautiful/atoms/Switch";
import { ConfirmDialog, DescriptionList, Icon, Notice, Sheet } from "../../components/ui/beautiful/controls";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { RecordTag } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";
import { useAdminLabels } from "../admin/shared";
import { ConnectorForm } from "./ConnectorForm";
import { connectMcp, McpPopupBlocked, saveMcpSecrets } from "./connect";
import { createBody, draftFrom, draftProblems, patchBody, type ConnectorDraft } from "./forms";
import { connectorDestination, REAUTH_CODES, useMcpLabels } from "./labels";
import { SecretFields } from "./SecretFields";

const DANGER_BUTTON = "bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95";
const TOUCH = "touch:h-11 touch:px-4";

/** `reconnect` offers 重新连接 inside the notice (a refused or failed sign-in). */
type Outcome = { tone: "success" | "danger" | "warning" | "info"; title: string; text?: string; link?: string; reconnect?: boolean } | null;
type Busy = "save" | "connect" | "disconnect" | "test" | "secrets" | "enable" | "confirm" | "delete" | null;

export interface ConnectorSheetProps {
  /** null creates a connector */
  connector: McpConnectorView | McpAdminConnector | null;
  /** `/api/mcp/connectors` (the user's view) or `/api/admin/mcp/connectors` */
  base: string;
  /** administrators edit organization connectors: credential mode, OAuth client, groups */
  admin?: { groups: string[]; redirectUri?: string | null };
  /** the definition may be edited, enabled, its tools switched and the connector deleted */
  manageable: boolean;
  allowLocal: boolean;
  oauthWarning: boolean;
  /** names of the owner's other connectors */
  takenNames: string[];
  onClose: () => void;
  /** re-read the list (status, secrets, tool counts changed) */
  onRefresh: () => Promise<unknown> | void;
  onCreated?: (connector: McpConnectorView) => void;
  onDeleted: (text: string) => void;
  /** the connector was just created by this form: say so, and what is left to do */
  justAdded?: boolean;
}

/** One connector: status and last error, connect or disconnect (OAuth), test, the caller's own secrets, the tool
 * list with per-tool switches, and edit, enable and delete when manageable. With `connector: null` it is the add
 * form. Secret values are never shown; inputs start empty and report only 已设置 / 未设置. */
export function ConnectorSheet({ connector, base, admin, manageable, allowLocal, oauthWarning, takenNames, onClose, onRefresh, onCreated, onDeleted, justAdded = false }: ConnectorSheetProps) {
  const w = useWords();
  const labels = useMcpLabels();
  const adminLabels = useAdminLabels();
  const formId = useId();
  const [editing, setEditing] = useState(connector === null);
  const [draft, setDraft] = useState<ConnectorDraft>(() => draftFrom(connector ?? undefined, admin ? {} : { kind: "remote" }));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [outcome, setOutcome] = useState<Outcome>(() => (justAdded && connector ? {
    tone: "success",
    title: w(`${connector.label || connector.name} was added`, `已添加 ${connector.label || connector.name}`, `已新增 ${connector.label || connector.name}`),
    text: connector.status === "needs_auth" ? w("Connect it to sign in; the AI can use it after that.", "点击“连接”完成登录后，AI 就可以使用它。", "點選「連線」完成登入後，AI 就可以使用它。")
      : connector.status === "needs_secrets" ? w("Enter the missing keys below; the AI can use it after that.", "在下方填写缺少的密钥后，AI 就可以使用它。", "在下方填寫缺少的金鑰後，AI 就可以使用它。")
      : w("The AI can use it from the next message.", "AI 从下一条消息起可以使用它。", "AI 從下一則訊息起可以使用它。"),
  } : null));
  const [formError, setFormError] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const problems = draftProblems(draft, takenNames, Boolean(admin));
  const invalid = Object.keys(problems).length > 0;
  const path = connector ? `${base}/${connector.id}` : base;
  const credentialKeys = connector ? [...connector.header_keys, ...connector.env_keys] : [];
  // The caller holds the credentials of a personal connector and of a per-user organization one; an
  // administrator holds those of a shared organization connector.
  const ownsCredentials = connector !== null && (admin ? connector.credential_mode === "shared" : connector.scope === "personal" || connector.credential_mode === "per_user");
  // A connector the AI or an import added does nothing until the user confirms where it connects.
  const pending = connector?.status === "pending_confirmation";
  const canConnect = connector?.auth === "oauth" && ownsCredentials && !pending;
  // The caller's own values can be entered here unless the edit form (with the definition) holds them.
  const ownSecrets = connector !== null && !admin && ownsCredentials && credentialKeys.length > 0 && !pending;
  const secretsDirty = Object.values(secrets).some(Boolean);
  const name = connector?.label || connector?.name || "";

  async function run(kind: Exclude<Busy, null>, work: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setOutcome(null);
    try {
      await work();
    } catch (cause) {
      if (kind === "delete") setDeleteError(cause instanceof Error ? cause.message : String(cause));
      else if (kind === "save") setFormError(cause instanceof Error ? cause.message : String(cause));
      else setOutcome(failure(cause));
    } finally {
      setBusy(null);
    }
  }

  function failure(cause: unknown): Outcome {
    const text = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof ApiError && REAUTH_CODES.includes(cause.code)) {
      const oauth = connector?.auth === "oauth";
      return { tone: "warning", title: w("Re-authorization needed", "需要重新授权", "需要重新授權"), reconnect: oauth && canConnect,
        text: oauth
          ? w("The service no longer accepts the saved sign-in. Connect again to continue.", "服务不再接受已保存的登录，请重新连接。", "服務不再接受已儲存的登入，請重新連線。")
          : w("The service rejected the saved keys. Enter new ones to continue.", "服务拒绝了已保存的密钥，请填写新的密钥。", "服務拒絕了已儲存的金鑰，請填寫新的金鑰。") };
    }
    if (cause instanceof ApiError && cause.code === "confirmation_required") {
      return { tone: "warning", title: w("Confirm this connector first", "请先确认这个连接器", "請先確認這個連接器"), text };
    }
    if (cause instanceof ApiError && cause.code === "not_connected") return { tone: "info", ...labels.notConnected };
    if (cause instanceof McpPopupBlocked) {
      return { tone: "warning", title: w("The sign-in window was blocked", "登录窗口被浏览器拦截了", "登入視窗被瀏覽器攔截了"), text: w("Open the sign-in page yourself; this page updates when you finish.", "请手动打开登录页面，完成后此页面会自动更新。", "請手動開啟登入頁面，完成後此頁面會自動更新。"), link: cause.url };
    }
    if (cause instanceof ApiError && cause.code === "oauth_registration_required") {
      return { tone: "warning", title: w("This server needs a pre-registered OAuth client", "该服务需要预先注册的 OAuth 客户端", "該服務需要預先註冊的 OAuth 用戶端"),
        text: admin ? w("Register the platform with the provider, then enter its client ID (and secret) in Edit.", "请在服务方注册平台，然后在“编辑”中填写客户端 ID（和密钥）。", "請在服務方註冊平台，然後在「編輯」中填寫用戶端 ID（和密鑰）。")
          : w("Ask an administrator to register an OAuth client for it.", "请联系管理员为它注册 OAuth 客户端。", "請聯絡管理員為它註冊 OAuth 用戶端。") };
    }
    if (cause instanceof ApiError && cause.code === "oauth_https_required") return { tone: "warning", title: labels.httpsWarning.title, text: labels.httpsWarning.body };
    return { tone: "danger", title: w("That did not work", "操作失败", "操作失敗"), text };
  }

  // Called straight from the click so the popup opens inside the user's gesture.
  function connect() {
    if (!connector || busy) return;
    setBusy("connect");
    setOutcome(null);
    connectMcp(`${path}/connect`, connector.id)
      .then(async (result) => {
        await onRefresh();
        if (result === "connected") setOutcome({ tone: "success", title: w(`${name} is connected`, `已连接 ${name}`, `已連線 ${name}`) });
      })
      .catch((cause) => {
        const outcome = failure(cause);
        // A sign-in the callback reported as failed can simply be tried again.
        setOutcome(outcome && !(cause instanceof ApiError) && !(cause instanceof McpPopupBlocked) ? { ...outcome, reconnect: true } : outcome);
      })
      .finally(() => setBusy(null));
  }

  const disconnect = () => run("disconnect", async () => {
    await request(`${path}/connection`, { method: "DELETE" });
    await onRefresh();
    setOutcome({ tone: "success", title: w(`${name} is disconnected`, `已断开 ${name}`, `已中斷 ${name}`), text: w("Its sign-in was removed from the platform.", "平台上保存的登录信息已删除。", "平台上儲存的登入資訊已刪除。") });
  });

  const test = () => run("test", async () => {
    const result = await request<McpTestResult>(`${path}/test`, { method: "POST", body: "{}" });
    await onRefresh();
    const server = result.server ? [result.server.name, result.server.version].filter(Boolean).join(" ") : "";
    setOutcome(result.ok
      ? { tone: "success", title: w("The connection works", "连接正常", "連線正常"), text: [server, w(`${result.tools} tools`, `${result.tools} 个工具`, `${result.tools} 個工具`)].filter(Boolean).join(" · ") }
      : { tone: "danger", title: w("The connection failed", "连接失败", "連線失敗"), text: result.error ?? undefined });
  });

  const saveSecrets = () => run("secrets", async () => {
    if (!connector) return;
    await saveMcpSecrets(connector.id, Object.fromEntries(Object.entries(secrets).filter(([, value]) => value)));
    setSecrets({});
    await onRefresh();
    setOutcome({ tone: "success", title: w("Keys saved", "密钥已保存", "金鑰已儲存"), text: w("They are stored on the platform and never shown again.", "密钥保存在平台上，之后不会再显示。", "金鑰儲存在平台上，之後不會再顯示。") });
  });

  const setEnabled = (enabled: boolean) => run("enable", async () => {
    await request(path, { method: "PATCH", body: JSON.stringify({ enabled }) });
    await onRefresh();
  });

  const confirm = () => run("confirm", async () => {
    await request(`${path}/confirm`, { method: "POST", body: "{}" });
    await onRefresh();
    setOutcome({ tone: "success", title: w(`${name} is confirmed and on`, `已确认并启用 ${name}`, `已確認並啟用 ${name}`),
      text: w("The AI can use it from the next message once any sign-in or keys are in place.", "完成所需的登录或密钥后，AI 从下一条消息起可以使用它。", "完成所需的登入或金鑰後，AI 從下一則訊息起可以使用它。") });
  });

  const save = () => {
    setAttempted(true);
    if (invalid) return;
    setFormError("");
    void run("save", async () => {
      if (!connector) {
        const created = (await request<{ connector: McpConnectorView }>(base, { method: "POST", body: JSON.stringify(createBody(draft, Boolean(admin))) })).connector;
        await onRefresh();
        onCreated?.(created);
        return;
      }
      await request(path, { method: "PATCH", body: JSON.stringify(patchBody(draft, connector, Boolean(admin))) });
      await onRefresh();
      setEditing(false);
      setOutcome({ tone: "success", title: w("Saved", "已保存", "已儲存"), text: w("The AI uses the change from the next message.", "AI 从下一条消息起使用新设置。", "AI 從下一則訊息起使用新設定。") });
    });
  };

  const remove = () => run("delete", async () => {
    if (!connector) return;
    await request(path, { method: "DELETE" });
    setConfirming(false);
    onDeleted(w(`${name} was deleted.`, `已删除 ${name}。`, `已刪除 ${name}。`));
  });

  const startEditing = () => {
    if (!connector) return;
    setDraft(draftFrom(connector));
    setAttempted(false);
    setFormError("");
    setOutcome(null);
    setEditing(true);
  };

  if (editing) {
    return <Sheet open onClose={() => { if (!busy) onClose(); }} width={520}
      title={connector ? w(`Edit ${name}`, `编辑 ${name}`, `編輯 ${name}`) : w("Add a connector", "添加连接器", "新增連接器")}
      description={connector ? undefined : w("Connect your AI to another service. Keys and sign-ins stay on the platform; the AI never sees them.", "把 AI 连接到其他服务。密钥和登录信息保存在平台上，AI 永远看不到。", "把 AI 連接到其他服務。金鑰和登入資訊儲存在平台上，AI 永遠看不到。")}
      footer={<>
        <Button size="sm" className={TOUCH} disabled={busy !== null} onClick={() => (connector ? setEditing(false) : onClose())}>{w("Cancel", "取消", "取消")}</Button>
        <Button size="sm" variant="primary" type="submit" form={formId} className={TOUCH} disabled={busy !== null || (attempted && invalid)} aria-busy={busy === "save" || undefined}>
          {busy === "save" ? w("Saving…", "正在保存…", "正在儲存…") : connector ? w("Save", "保存", "儲存") : w("Add connector", "添加连接器", "新增連接器")}
        </Button>
      </>}>
      <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        {formError && <Notice tone="danger" title={connector ? w("The change was not saved", "更改未保存", "變更未儲存") : w("The connector was not added", "连接器未添加", "連接器未新增")}>{formError}</Notice>}
        <ConnectorForm draft={draft} onChange={setDraft} editing={connector !== null} allowLocal={allowLocal} admin={admin} oauthWarning={oauthWarning}
          problems={problems} showProblems={attempted} disabled={busy !== null} />
      </form>
    </Sheet>;
  }

  if (!connector) return null;
  const statusHint: Record<McpConnectorView["status"], string> = {
    connected: w("The AI can use its tools.", "AI 可以使用它的工具。", "AI 可以使用它的工具。"),
    idle: w("Connects automatically when the AI needs it.", "AI 需要时会自动连接。", "AI 需要時會自動連線。"),
    needs_auth: !canConnect ? w("An administrator needs to connect it.", "需要管理员完成连接。", "需要管理員完成連線。")
      : connector.last_error ? w("The service refused the saved sign-in; connect again.", "服务拒绝了已保存的登录，请重新连接。", "服務拒絕了已儲存的登入，請重新連線。")
      : w("Sign in to let the AI use it.", "登录后 AI 才能使用它。", "登入後 AI 才能使用它。"),
    needs_secrets: ownSecrets || (admin && ownsCredentials) ? w("Enter the missing keys to let the AI use it.", "填写缺少的密钥后 AI 才能使用它。", "填寫缺少的金鑰後 AI 才能使用它。") : w("An administrator needs to enter its keys.", "需要管理员填写密钥。", "需要管理員填寫金鑰。"),
    error: w("The last attempt failed.", "上次连接失败。", "上次連線失敗。"),
    pending_confirmation: w("Not used until you confirm it.", "确认之前不会使用。", "確認之前不會使用。"),
  };
  const tone = labels.tone(connector);
  const source = labels.source(connector);
  const details = [
    connector.transport === "stdio"
      ? { key: "command", label: w("Command", "命令", "命令"), value: <span className="font-mono text-[12.5px]" title={[connector.command, ...(connector.args ?? [])].join(" ")}>{[connector.command, ...(connector.args ?? [])].join(" ")}</span> }
      : { key: "url", label: w("Server URL", "服务地址", "服務位址"), value: <span className="font-mono text-[12.5px]" title={connector.url ?? ""}>{connector.url}</span> },
    { key: "kind", label: w("Kind", "类型", "類型"), value: labels.transport(connector) },
    { key: "auth", label: w("Authentication", "认证方式", "驗證方式"), value: labels.auth(connector.auth) },
    ...(connector.scope === "org" && connector.auth !== "none" ? [{ key: "mode", label: w("Credentials", "凭据", "憑證"), value: labels.credentialMode(connector) }] : []),
    ...(admin && connector.groups ? [{ key: "groups", label: w("Available to", "可使用的权限组", "可使用的權限群組"), value: connector.groups.includes("*") ? w("Everyone", "所有人", "所有人") : connector.groups.map(adminLabels.group).join("、") }] : []),
    ...(source ? [{ key: "source", label: w("Source", "来源", "來源"), value: source.label }] : []),
  ];

  return <>
    <Sheet open onClose={onClose} width={520} title={name}
      description={<span className="font-mono text-[12px]">{connector.name}</span>}
      footer={manageable ? <>
        <Button size="sm" className={`mr-auto ${TOUCH} ${DANGER_BUTTON}`} disabled={busy !== null} onClick={() => { setDeleteError(""); setConfirming(true); }}>{w("Delete", "删除", "刪除")}</Button>
        <Button size="sm" variant="secondary" className={TOUCH} disabled={busy !== null} onClick={startEditing}><Icon name="pencil" size={14} />{w("Edit", "编辑", "編輯")}</Button>
      </> : undefined}>
      <div className="flex flex-col gap-5">
        <section aria-label={w("Status", "状态", "狀態")} className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusPill tone={tone}>{labels.status(connector)}</StatusPill>
            <p className="min-w-0 flex-1 text-[12.5px] leading-[1.45] text-ink-2">{pending || connector.enabled ? statusHint[connector.status] : w("Turned off; the AI does not see it.", "已停用，AI 看不到它。", "已停用，AI 看不到它。")}</p>
            {manageable && !pending && <span className="flex shrink-0 items-center touch:min-h-11">
              <Switch checked={connector.enabled} disabled={busy !== null} onChange={(enabled) => void setEnabled(enabled)} label={w(`Enable ${name}`, `启用 ${name}`, `啟用 ${name}`)} />
            </span>}
          </div>
          {pending && <Notice tone="warning" title={source?.key === "ai"
            ? w("Your AI added this connector. Check it before it runs.", "这个连接器由 AI 添加，请确认后再启用。", "這個連接器由 AI 新增，請確認後再啟用。")
            : w("This connector was imported. Check it before it runs.", "这个连接器是导入的，请确认后再启用。", "這個連接器是匯入的，請確認後再啟用。")}>
            <span className="block">{connector.transport === "stdio"
              ? w("It will start this program in your computer:", "它会在你的电脑里启动这个程序：", "它會在你的電腦裡啟動這個程式：")
              : w("It will connect to:", "它将连接到：", "它將連線到：")}</span>
            <span className="mt-1 block font-mono text-[12.5px] break-all text-ink">{connectorDestination(connector)}</span>
            <span className="mt-1 block">{w("Until you confirm, the AI cannot use it and you cannot sign in or enter keys for it.", "确认之前，AI 不能使用它，也不能为它登录或填写密钥。", "確認之前，AI 不能使用它，也不能為它登入或填寫金鑰。")}</span>
          </Notice>}
          {connector.status === "error" && connector.last_error && <Notice tone="danger" title={w("Last error", "最近一次错误", "最近一次錯誤")}><span className="font-mono text-[12px] break-all">{connector.last_error}</span></Notice>}
          {connector.status === "needs_auth" && connector.last_error && <Notice tone="warning" title={w("Re-authorization needed", "需要重新授权", "需要重新授權")}><span className="font-mono text-[12px] break-all">{connector.last_error}</span></Notice>}
          {connector.auth === "oauth" && connector.oauth_warning === "https_required" && <Notice tone="warning" title={labels.httpsWarning.title}>{labels.httpsWarning.body}</Notice>}
          <div className="flex flex-wrap gap-2">
            {pending && manageable && <Button size="sm" variant="primary" className={TOUCH} disabled={busy !== null} aria-busy={busy === "confirm" || undefined} onClick={() => void confirm()}>
              <Icon name="check" size={14} />{busy === "confirm" ? w("Confirming…", "正在确认…", "正在確認…") : w("Confirm and turn on", "确认并启用", "確認並啟用")}
            </Button>}
            {canConnect && (connector.status === "needs_auth"
              ? <Button size="sm" variant="primary" className={TOUCH} disabled={busy !== null} aria-busy={busy === "connect" || undefined} onClick={connect}>
                <Icon name="external" size={14} />{busy === "connect" ? w("Waiting for sign-in…", "等待登录…", "等待登入…") : w("Connect", "连接", "連線")}
              </Button>
              : <>
                <Button size="sm" variant="secondary" className={TOUCH} disabled={busy !== null} aria-busy={busy === "connect" || undefined} onClick={connect}>{w("Reconnect", "重新连接", "重新連線")}</Button>
                <Button size="sm" variant="secondary" className={TOUCH} disabled={busy !== null} aria-busy={busy === "disconnect" || undefined} onClick={() => void disconnect()}>{w("Disconnect", "断开", "中斷連線")}</Button>
              </>)}
            {!pending && <Button size="sm" variant="secondary" className={TOUCH} disabled={busy !== null || !connector.enabled} aria-busy={busy === "test" || undefined} onClick={() => void test()}>
              <Icon name="refresh" size={14} className={busy === "test" ? "animate-spin motion-reduce:animate-none" : undefined} />{busy === "test" ? w("Testing…", "正在测试…", "正在測試…") : w("Test connection", "测试连接", "測試連線")}
            </Button>}
          </div>
          {outcome && <Notice tone={outcome.tone} title={outcome.title} onDismiss={() => setOutcome(null)}>
            {outcome.text}
            {outcome.link && <a className="mt-1 flex items-center gap-1 font-medium text-accent-ink underline touch:min-h-11" href={outcome.link} target="_blank" rel="noopener noreferrer">
              {w("Open the sign-in page", "打开登录页面", "開啟登入頁面")}<Icon name="external" size={12} />
            </a>}
            {outcome.reconnect && canConnect && <Button size="sm" variant="secondary" className={`mt-2 ${TOUCH}`} disabled={busy !== null} onClick={connect}>{w("Reconnect", "重新连接", "重新連線")}</Button>}
          </Notice>}
        </section>

        {ownSecrets && <form noValidate aria-label={w("Your keys", "你的密钥", "你的金鑰")} className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
          onSubmit={(event) => { event.preventDefault(); if (secretsDirty) void saveSecrets(); }}>
          <div>
            <h3 className="text-[13px] font-medium text-ink">{w("Your keys", "你的密钥", "你的金鑰")}</h3>
            <p className="mt-0.5 text-[12px] leading-[1.4] text-ink-2">{w("Stored on the platform for your account only. The AI never sees them.", "仅为你的账户保存在平台上，AI 永远看不到。", "僅為你的帳戶儲存在平台上，AI 永遠看不到。")}</p>
          </div>
          <SecretFields keys={credentialKeys} set={connector.secrets_set} values={secrets} onChange={setSecrets} disabled={busy !== null} />
          <Button type="submit" size="sm" variant={connector.status === "needs_secrets" ? "primary" : "secondary"} className={`self-end ${TOUCH}`} disabled={busy !== null || !secretsDirty} aria-busy={busy === "secrets" || undefined}>
            {busy === "secrets" ? w("Saving…", "正在保存…", "正在儲存…") : w("Save keys", "保存密钥", "儲存金鑰")}
          </Button>
        </form>}

        <DescriptionList items={details} className="px-1" />

        <ToolList connector={connector} base={base} manageable={manageable} />
      </div>
    </Sheet>
    <ConfirmDialog
      open={confirming}
      tone="danger"
      title={w(`Delete ${name}?`, `删除 ${name}？`, `刪除 ${name}？`)}
      description={connector.scope === "org"
        ? w("No one's AI can use it any more, and every stored key and sign-in for it is removed. This cannot be undone.", "所有人的 AI 都将无法使用它，为它保存的密钥和登录信息会全部删除。删除后无法恢复。", "所有人的 AI 都將無法使用它，為它儲存的金鑰和登入資訊會全部刪除。刪除後無法復原。")
        : w("Your AI stops using it from the next message, and its stored keys and sign-in are removed. This cannot be undone.", "AI 从下一条消息起不再使用它，保存的密钥和登录信息会删除。删除后无法恢复。", "AI 從下一則訊息起不再使用它，儲存的金鑰和登入資訊會刪除。刪除後無法復原。")}
      confirmLabel={w("Delete connector", "删除连接器", "刪除連接器")}
      busy={busy === "delete"}
      error={deleteError || undefined}
      onConfirm={() => void remove()}
      onCancel={() => setConfirming(false)}
    />
  </>;
}

/** The connector's tools; switches when manageable. A switched-off tool is hidden from every AI using the connector. */
function ToolList({ connector, base, manageable }: { connector: McpConnectorView; base: string; manageable: boolean }) {
  const w = useWords();
  const labels = useMcpLabels();
  const headingId = useId();
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [error, setError] = useState("");
  // The typed code of a refused catalog read: `needs_auth` / `credentials_rejected` (the server refused the stored
  // credentials) or `not_connected` (an administrator without their own sign-in for a per-user connector).
  const [errorCode, setErrorCode] = useState("");
  // One switch saves at a time: each PATCH carries the whole list.
  const [saving, setSaving] = useState<string | null>(null);
  const reachable = connector.enabled && (connector.status === "connected" || connector.status === "idle" || connector.status === "error");

  useEffect(() => {
    if (!reachable) return;
    let current = true;
    setError("");
    request<McpCatalog>(`${base}/${connector.id}/catalog`)
      .then((next) => { if (current) setCatalog(next); })
      .catch((cause) => {
        if (!current) return;
        setErrorCode(cause instanceof ApiError ? cause.code : "");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { current = false; };
  }, [base, connector.id, reachable]);

  async function toggle(tool: string, enabled: boolean) {
    if (!catalog || saving) return;
    // Names the server no longer offers stay switched off.
    const offered = catalog.tools.map((item) => item.name);
    const disabled = [
      ...connector.disabled_tools.filter((name) => !offered.includes(name)),
      ...catalog.tools.filter((item) => (item.name === tool ? !enabled : !item.enabled)).map((item) => item.name),
    ];
    setSaving(tool);
    setError("");
    try {
      await request(`${base}/${connector.id}`, { method: "PATCH", body: JSON.stringify({ disabled_tools: disabled }) });
      setCatalog((current) => current && { ...current, tools: current.tools.map((item) => (item.name === tool ? { ...item, enabled } : item)) });
    } catch (cause) {
      setErrorCode("");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }

  const enabledCount = catalog?.tools.filter((tool) => tool.enabled).length ?? 0;
  return <section aria-labelledby={headingId} className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline gap-x-2 px-1">
      <h3 id={headingId} className="text-[13px] font-medium text-ink">{w("Tools", "工具", "工具")}</h3>
      {catalog && <span className="text-[12px] text-ink-2 tabular-nums">{w(`${enabledCount} of ${catalog.tools.length} on`, `已启用 ${enabledCount}/${catalog.tools.length}`, `已啟用 ${enabledCount}/${catalog.tools.length}`)}</span>}
    </div>
    {error && (REAUTH_CODES.includes(errorCode)
      ? <Notice tone="warning" title={w("Re-authorization needed", "需要重新授权", "需要重新授權")}>{w("The service refused the saved credentials, so its tools cannot be listed. Connect again or update the keys above.", "服务拒绝了已保存的凭据，无法列出工具。请重新连接或更新上方的密钥。", "服務拒絕了已儲存的憑證，無法列出工具。請重新連線或更新上方的金鑰。")}</Notice>
      : errorCode === "not_connected" ? <Notice tone="info" title={labels.notConnected.title}>{labels.notConnected.text}</Notice>
      : <Notice tone="danger" title={w("Tools could not be loaded or saved", "无法加载或保存工具", "無法載入或儲存工具")}>{error}</Notice>)}
    {!reachable
      ? <p className="rounded-card bg-surface px-4 py-3 text-[12.5px] text-ink-2 shadow-card">{connector.status === "pending_confirmation" ? w("Its tools appear here once you confirm it and it connects.", "确认并连接后这里会显示它的工具。", "確認並連線後這裡會顯示它的工具。") : connector.enabled ? w("Its tools appear here once it is connected.", "连接后这里会显示它的工具。", "連線後這裡會顯示它的工具。") : w("Turn it on to see its tools.", "启用后可以查看它的工具。", "啟用後可以查看它的工具。")}</p>
      : !catalog ? (!error && <LoadingState label={w("Loading tools…", "正在加载工具…", "正在載入工具…")} />)
      : catalog.tools.length === 0
        ? <p className="rounded-card bg-surface px-4 py-3 text-[12.5px] text-ink-2 shadow-card">{w("This server offers no tools.", "这个服务没有提供工具。", "這個服務沒有提供工具。")}</p>
        : <ul className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
          {catalog.tools.map((tool) => (
            <li key={tool.name} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate font-mono text-[12.5px] text-ink">{tool.name}</span>
                  {tool.read_only && <RecordTag tag={{ key: "read-only", label: w("Read-only", "只读", "唯讀"), hue: "neutral" }} />}
                </div>
                {tool.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-ink-2">{tool.description}</p>}
              </div>
              {manageable
                ? <span className="flex shrink-0 items-center touch:min-h-11">
                  <Switch checked={tool.enabled} disabled={saving !== null} onChange={(enabled) => void toggle(tool.name, enabled)} label={w(`Allow ${tool.name}`, `允许 ${tool.name}`, `允許 ${tool.name}`)} />
                </span>
                : !tool.enabled && <span className="shrink-0 text-[12px] text-ink-2">{w("Off", "已停用", "已停用")}</span>}
            </li>
          ))}
        </ul>}
  </section>;
}
