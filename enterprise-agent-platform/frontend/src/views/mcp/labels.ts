import type { McpAuth, McpCallRow, McpConnectorView, McpStatus } from "../../api";
import type { RecordTagValue } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";

export type StatusTone = "green" | "orange" | "red" | "neutral";

const STATUS_TONE: Record<McpStatus, StatusTone> = { connected: "green", needs_auth: "orange", needs_secrets: "orange", error: "red", idle: "neutral", pending_confirmation: "orange" };

/** Upstream auth failures (HTTP 409): the server refused the stored sign-in or keys, so the user must authorize again. */
export const REAUTH_CODES: readonly string[] = ["needs_auth", "credentials_rejected"];

/** Where a connector sends its traffic: the URL's origin (never its path or query), or the local command line. */
export function connectorDestination(connector: Pick<McpConnectorView, "transport" | "url" | "command" | "args">): string {
  if (connector.transport === "stdio") return [connector.command, ...(connector.args ?? [])].filter(Boolean).join(" ");
  try {
    return connector.url ? new URL(connector.url).origin : "";
  } catch {
    return connector.url ?? "";
  }
}
/** The RecordStatus dot for each status. */
export const STATUS_COLOR: Record<StatusTone, string> = { green: "var(--green)", orange: "var(--orange)", red: "var(--red)", neutral: "var(--ink-3)" };

/** Connector copy shared by Settings, Administration, channels and the conversation cards. */
export function useMcpLabels() {
  const w = useWords();
  const statuses: Record<McpStatus, string> = {
    connected: w("Connected", "已连接", "已連線"),
    needs_auth: w("Sign-in needed", "需要登录", "需要登入"),
    needs_secrets: w("Keys needed", "需要填写密钥", "需要填寫金鑰"),
    error: w("Error", "出错", "出錯"),
    idle: w("Ready", "就绪", "就緒"),
    pending_confirmation: w("Awaiting your confirmation", "待确认", "待確認"),
  };
  const auths: Record<McpAuth, string> = {
    none: w("No authentication", "无需认证", "無需驗證"),
    headers: w("API key or headers", "API 密钥或请求头", "API 金鑰或請求標頭"),
    oauth: "OAuth",
  };
  const calls: Record<McpCallRow["status"], string> = {
    ok: w("Succeeded", "成功", "成功"),
    error: w("Failed", "失败", "失敗"),
    cancelled: w("Cancelled", "已取消", "已取消"),
    timeout: w("Timed out", "超时", "逾時"),
  };
  // An administrator testing a per-user organization connector uses their own sign-in or keys.
  const notConnected = {
    title: w("You have not connected it yourself", "你自己还没有连接它", "你自己還沒有連線它"),
    text: w("Each person uses their own account here. Connect it or enter your keys in Settings → Connectors, then test or list its tools.", "这个连接器每人使用自己的账号。请先在“设置 → 连接器”中连接或填写你的密钥，再测试或查看工具。", "這個連接器每人使用自己的帳號。請先在「設定 → 連接器」中連線或填寫你的金鑰，再測試或查看工具。"),
  };
  return {
    notConnected,
    /** A connector that was refused after connecting before (it has a last error) needs sign-in again, not a first one. */
    status: (connector: Pick<McpConnectorView, "status" | "enabled" | "last_error">) =>
      connector.status === "pending_confirmation" ? statuses.pending_confirmation
        : !connector.enabled ? w("Off", "已停用", "已停用")
        : connector.status === "needs_auth" && connector.last_error ? w("Re-authorization needed", "需要重新授权", "需要重新授權")
        : statuses[connector.status],
    tone: (connector: Pick<McpConnectorView, "status" | "enabled">): StatusTone =>
      (connector.enabled || connector.status === "pending_confirmation" ? STATUS_TONE[connector.status] : "neutral"),
    auth: (auth: McpAuth) => auths[auth],
    transport: (connector: Pick<McpConnectorView, "transport">) =>
      connector.transport === "stdio" ? w("Local program", "本地程序", "本機程式") : connector.transport === "sse" ? w("Remote · SSE", "远程 · SSE", "遠端 · SSE") : w("Remote", "远程", "遠端"),
    credentialMode: (connector: Pick<McpConnectorView, "credential_mode">) =>
      connector.credential_mode === "shared" ? w("Shared", "共享凭据", "共用憑證") : w("Per user", "每人授权", "每人授權"),
    /** where a personal connector came from; null for one added by hand */
    source: (connector: Pick<McpConnectorView, "source">): RecordTagValue | null => {
      if (connector.source === "ai") return { key: "ai", label: w("Added by AI", "AI 添加", "AI 新增") };
      if (connector.source === "legacy") return { key: "legacy", label: w("Migrated", "已迁移", "已遷移"), hue: "neutral" };
      if (connector.source.startsWith("import")) return { key: "import", label: w("Imported", "已导入", "已匯入") };
      return null;
    },
    call: (status: McpCallRow["status"]) => calls[status],
    callColor: (status: McpCallRow["status"]) => STATUS_COLOR[status === "ok" ? "green" : status === "error" ? "red" : "orange"],
    httpsWarning: {
      title: w("OAuth sign-in needs an HTTPS address", "OAuth 登录需要 HTTPS 地址", "OAuth 登入需要 HTTPS 位址"),
      body: w("The platform's public address is neither HTTPS nor this computer, so identity providers will refuse to return to it. Ask the operator to serve the platform over HTTPS; connectors with API keys or no authentication are not affected.",
        "平台的公开地址既不是 HTTPS 也不是本机地址，身份提供方会拒绝跳转回来。请让运维人员为平台启用 HTTPS；使用 API 密钥或无需认证的连接器不受影响。",
        "平台的公開位址既不是 HTTPS 也不是本機位址，身分提供者會拒絕跳轉回來。請讓維運人員為平台啟用 HTTPS；使用 API 金鑰或無需驗證的連接器不受影響。"),
    },
  };
}
