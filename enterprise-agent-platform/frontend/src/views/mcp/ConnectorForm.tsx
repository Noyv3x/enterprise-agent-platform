import { useId } from "react";
import { SegmentedControl } from "../../components/ui/beautiful/atoms/SegmentedControl";
import { Switch } from "../../components/ui/beautiful/atoms/Switch";
import { Field, FormGrid, Notice, TextArea, TextField } from "../../components/ui/beautiful/controls";
import type { McpAuth } from "../../api";
import { useWords } from "../../words";
import { GroupAssignment } from "../admin/GroupAssignment";
import { writesValues, type ConnectorDraft, type DraftProblems } from "./forms";
import { useMcpLabels } from "./labels";
import { SecretRows, SecretState } from "./SecretFields";

const AUTHS: readonly McpAuth[] = ["none", "headers", "oauth"];

/** The connector definition form, for a personal connector (remote, or a local program when the personal AI may
 * run one) or, with `admin`, an organization connector (credential mode, pre-registered OAuth client, groups). */
export function ConnectorForm({ draft, onChange, editing, allowLocal, admin, oauthWarning, problems, showProblems, disabled = false }: {
  draft: ConnectorDraft;
  onChange: (draft: ConnectorDraft) => void;
  /** an existing connector: its name and kind are fixed */
  editing: boolean;
  allowLocal: boolean;
  admin?: { groups: string[]; redirectUri?: string | null };
  oauthWarning: boolean;
  problems: DraftProblems;
  /** show problems of untouched fields too (after a submit attempt) */
  showProblems: boolean;
  disabled?: boolean;
}) {
  const w = useWords();
  const labels = useMcpLabels();
  const id = useId();
  const set = (change: Partial<ConnectorDraft>) => onChange({ ...draft, ...change });
  const kinds = { remote: w("Remote server", "远程服务", "遠端服務"), local: w("Local program", "本地程序", "本機程式") };
  const transports = { http: w("Automatic", "自动", "自動"), sse: w("SSE (legacy)", "SSE（旧版）", "SSE（舊版）") };
  const authLabels: Record<McpAuth, string> = { none: w("None", "无需认证", "無需驗證"), headers: w("Headers", "请求头", "請求標頭"), oauth: "OAuth" };
  const modes = { per_user: w("Each person signs in", "每人授权", "每人授權"), shared: w("Shared credentials", "共享凭据", "共用憑證") };
  const show = (problem: unknown, touched: boolean) => Boolean(problem) && (showProblems || touched);

  return <div className="flex flex-col gap-4">
    {!editing && allowLocal && <Field group label={w("Kind", "类型", "類型")}
      hint={draft.kind === "local"
        ? w("Runs persistently in your own computer, for example a server started with npx or uvx. Only your personal AI can use it.", "在你自己的电脑（沙箱）里持续运行，例如用 npx 或 uvx 启动的服务器。只有个人 AI 可以使用。", "在你自己的電腦（沙箱）裡持續執行，例如用 npx 或 uvx 啟動的伺服器。只有個人 AI 可以使用。")
        : w("A server on the internet or your company network, such as Notion, GitHub or an internal system.", "互联网或公司网络上的服务，例如 Notion、GitHub 或内部系统。", "網際網路或公司網路上的服務，例如 Notion、GitHub 或內部系統。")}>
      <SegmentedControl options={[kinds.remote, kinds.local]} value={kinds[draft.kind]} className="w-full touch:h-11"
        onChange={(label) => { if (!disabled) set({ kind: label === kinds.local ? "local" : "remote" }); }} />
    </Field>}

    <FormGrid>
      <Field label={w("Name", "名称", "名稱")} id={`${id}-name`} required={!editing}
        error={show(problems.name, draft.name !== "")
          ? problems.name === "taken" ? w("You already have a connector with this name.", "已有同名连接器。", "已有同名連接器。") : w("Use 1–32 lowercase letters, digits and hyphens, starting with a letter or digit.", "请使用 1–32 个小写字母、数字或连字符，并以字母或数字开头。", "請使用 1–32 個小寫字母、數字或連字號，並以字母或數字開頭。")
          : undefined}
        hint={editing ? w("The name cannot change.", "名称不能修改。", "名稱不能修改。") : w("How the AI refers to it, e.g. notion.", "AI 用它称呼这个连接器，例如 notion。", "AI 用它稱呼這個連接器，例如 notion。")}>
        <TextField value={draft.name} readOnly={editing} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={32} inputClassName="font-mono"
          placeholder="notion" onChange={(event) => set({ name: event.target.value.toLowerCase() })} />
      </Field>
      <Field label={w("Display name", "显示名称", "顯示名稱")} id={`${id}-label`}>
        <TextField value={draft.label} disabled={disabled} autoComplete="off" maxLength={80} placeholder={draft.name || "Notion"} onChange={(event) => set({ label: event.target.value })} />
      </Field>
    </FormGrid>

    {draft.kind === "remote" ? <>
      <Field label={w("Server URL", "服务地址", "服務位址")} id={`${id}-url`} required
        error={show(problems.url, draft.url !== "") ? w("Enter an address that starts with https:// or http://", "请输入以 https:// 或 http:// 开头的地址", "請輸入以 https:// 或 http:// 開頭的位址") : undefined}
        hint={w("Internal addresses work only after an administrator allows them.", "内网地址需要管理员放行后才能使用。", "內網位址需要管理員放行後才能使用。")}>
        <TextField type="url" inputMode="url" value={draft.url} disabled={disabled} autoComplete="off" spellCheck={false}
          placeholder="https://mcp.notion.com/mcp" onChange={(event) => set({ url: event.target.value })} />
      </Field>
      <Field group label={w("Transport", "传输方式", "傳輸方式")}
        hint={draft.transport === "sse"
          ? w("Only for older servers that still use HTTP + SSE.", "仅用于仍使用 HTTP + SSE 的旧版服务器。", "僅用於仍使用 HTTP + SSE 的舊版伺服器。")
          : w("Streamable HTTP; the protocol version is negotiated with the server.", "Streamable HTTP，协议版本与服务器自动协商。", "Streamable HTTP，協定版本與伺服器自動協商。")}>
        <SegmentedControl options={[transports.http, transports.sse]} value={transports[draft.transport]} className="w-full touch:h-11"
          onChange={(label) => { if (!disabled) set({ transport: label === transports.sse ? "sse" : "http" }); }} />
      </Field>
      <Field group label={w("Authentication", "认证方式", "驗證方式")} hint={{
        none: w("The server needs no sign-in or key.", "服务不需要登录或密钥。", "服務不需要登入或金鑰。"),
        headers: w("An API key or token sent in request headers.", "通过请求头发送 API 密钥或令牌。", "透過請求標頭傳送 API 金鑰或權杖。"),
        oauth: w("Sign in on the service's own page; the platform keeps the resulting token.", "在服务方的页面登录授权，平台保存得到的令牌。", "在服務方的頁面登入授權，平台保存取得的權杖。"),
      }[draft.auth]}>
        <SegmentedControl options={AUTHS.map((auth) => authLabels[auth])} value={authLabels[draft.auth]} className="w-full touch:h-11"
          onChange={(label) => { if (!disabled) set({ auth: AUTHS.find((auth) => authLabels[auth] === label) ?? "none" }); }} />
      </Field>
      {admin && draft.auth !== "none" && <Field group label={w("Credentials", "凭据", "憑證")}
        hint={draft.credentialMode === "shared"
          ? w("You connect once here; everyone allowed uses that account. Required for channels.", "由你在这里连接一次，所有有权限的人都使用这个账号。频道只能使用共享凭据的连接器。", "由你在這裡連線一次，所有有權限的人都使用這個帳號。頻道只能使用共用憑證的連接器。")
          : w("Each person connects their own account in Settings → Connectors.", "每个人在“设置 → 连接器”中连接自己的账号。", "每個人在「設定 → 連接器」中連線自己的帳號。")}>
        <SegmentedControl options={[modes.per_user, modes.shared]} value={modes[draft.credentialMode]} className="w-full touch:h-11"
          onChange={(label) => { if (!disabled) set({ credentialMode: label === modes.shared ? "shared" : "per_user" }); }} />
      </Field>}
      {draft.auth === "headers" && <>
        <SecretRows kind="header" rows={draft.headers} withValues={writesValues(draft, Boolean(admin))} disabled={disabled} onChange={(headers) => set({ headers })} />
        {show(problems.headers === "empty", false) && <p className="text-[12px] text-red-ink">{w("Add at least one header.", "请至少添加一个请求头。", "請至少新增一個請求標頭。")}</p>}
      </>}
      {draft.auth === "oauth" && oauthWarning && <Notice tone="warning" title={labels.httpsWarning.title}>{labels.httpsWarning.body}</Notice>}
      {draft.auth === "oauth" && admin && <section aria-labelledby={`${id}-client`} className="flex flex-col gap-3 rounded-card bg-inset p-3">
        <div>
          <h3 id={`${id}-client`} className="text-[12.5px] font-medium text-ink">{w("Pre-registered OAuth client (optional)", "预先注册的 OAuth 客户端（可选）", "預先註冊的 OAuth 用戶端（選填）")}</h3>
          <p className="mt-0.5 text-[12px] leading-[1.4] text-ink-2">{w("Only needed when the server does not let the platform register itself. Register the redirect URI shown below with the provider.", "只有服务器不允许平台自动注册时才需要。请在服务方登记下方的回调地址。", "只有伺服器不允許平台自動註冊時才需要。請在服務方登記下方的回呼位址。")}</p>
          {admin.redirectUri && <p className="mt-1 font-mono text-[12px] break-all text-ink-2">{admin.redirectUri}</p>}
        </div>
        <FormGrid>
          <Field label={w("Client ID", "客户端 ID", "用戶端 ID")} id={`${id}-client-id`}>
            <TextField value={draft.clientId} disabled={disabled} autoComplete="off" spellCheck={false} inputClassName="font-mono" onChange={(event) => set({ clientId: event.target.value })} />
          </Field>
          <Field id={`${id}-client-secret`} label={<span className="inline-flex items-center gap-2">{w("Client secret", "客户端密钥", "用戶端密鑰")}<SecretState set={draft.clientSecretSet} /></span>}>
            <TextField type="password" value={draft.clientSecret} disabled={disabled || !draft.clientId.trim()} autoComplete="new-password" spellCheck={false}
              placeholder={draft.clientSecretSet ? w("Leave empty to keep", "留空则保留", "留空則保留") : w("For confidential clients", "机密客户端才需要", "機密用戶端才需要")}
              onChange={(event) => set({ clientSecret: event.target.value })} />
          </Field>
        </FormGrid>
        <Field label={w("Scopes", "授权范围", "授權範圍")} id={`${id}-scopes`} hint={w("Separated by spaces. Leave empty to use the server's defaults.", "用空格分隔。留空则使用服务器默认值。", "以空格分隔。留空則使用伺服器預設值。")}>
          <TextField value={draft.scopes} disabled={disabled} autoComplete="off" spellCheck={false} inputClassName="font-mono" onChange={(event) => set({ scopes: event.target.value })} />
        </Field>
      </section>}
    </> : <>
      <Field label={w("Command", "命令", "命令")} id={`${id}-command`} required
        error={show(problems.command, false) ? w("Enter the program to start.", "请输入要启动的程序。", "請輸入要啟動的程式。") : undefined}
        hint={w("A program on the PATH (npx, uvx, node, python) or a path inside your workspace. It is started directly, without a shell.", "PATH 中的程序（npx、uvx、node、python）或工作区内的路径。直接启动，不经过 shell。", "PATH 中的程式（npx、uvx、node、python）或工作區內的路徑。直接啟動，不經過 shell。")}>
        <TextField value={draft.command} disabled={disabled} autoComplete="off" spellCheck={false} inputClassName="font-mono" placeholder="npx" onChange={(event) => set({ command: event.target.value })} />
      </Field>
      <Field label={w("Arguments", "参数", "參數")} id={`${id}-args`} hint={w("One per line.", "每行一个。", "每行一個。")}>
        <TextArea value={draft.args} rows={3} maxRows={10} disabled={disabled} spellCheck={false} className="font-mono" placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/workspace"} onChange={(event) => set({ args: event.target.value })} />
      </Field>
      <Field label={w("Working folder", "工作目录", "工作目錄")} id={`${id}-cwd`} hint={w("Optional; inside your workspace.", "可选，须在工作区内。", "選填，須在工作區內。")}>
        <TextField value={draft.cwd} disabled={disabled} autoComplete="off" spellCheck={false} inputClassName="font-mono" placeholder="/workspace" onChange={(event) => set({ cwd: event.target.value })} />
      </Field>
      <SecretRows kind="env" rows={draft.env} disabled={disabled} onChange={(env) => set({ env })} />
    </>}

    {admin && <>
      <GroupAssignment value={draft.groups} onChange={(groups) => set({ groups })} groups={admin.groups} disabled={disabled} hints={{
        everyone: w("Every account can use this connector.", "所有账户都可以使用这个连接器。", "所有帳戶都可以使用這個連接器。"),
        chosen: w("Only accounts in these groups can use this connector.", "只有这些权限组的账户可以使用这个连接器。", "只有這些權限群組的帳戶可以使用這個連接器。"),
      }} />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink">{w("Enabled", "启用", "啟用")}</div>
          <p className="text-[12px] leading-[1.4] text-ink-2">{w("When off, no one's AI can use it; its settings and credentials are kept.", "停用后任何人的 AI 都不能使用它，设置和凭据会保留。", "停用後任何人的 AI 都不能使用它，設定和憑證會保留。")}</p>
        </div>
        <span className="flex shrink-0 items-center touch:min-h-11">
          <Switch checked={draft.enabled} disabled={disabled} onChange={(enabled) => set({ enabled })} label={w("Enabled", "启用", "啟用")} />
        </span>
      </div>
    </>}
  </div>;
}
