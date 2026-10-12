import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, request, type McpConnectorList } from "../../api";
import { Button, buttonVariants } from "../../components/ui/beautiful/atoms/Button";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import { Switch } from "../../components/ui/beautiful/atoms/Switch";
import { Field, Icon, MultiSelect, Select, TextArea, TextField } from "../../components/ui/beautiful/controls";
import { cn } from "../../components/ui/beautiful/cn";
import { useWords } from "../../words";
import { McpPopupBlocked, connectMcp, saveMcpSecrets } from "../mcp/connect";
import { SecretFields } from "../mcp/SecretFields";
import { formContent, initialValues, parseSchema, type FormValues, type SchemaField } from "./mcpSchema";
import type { ElicitationOutcome, ElicitationState, McpActionConnector, McpActionRequired } from "./types";
import { errorText } from "./useConversation";
import type { Words } from "./work";

/* Conversation cards for MCP connectors: signing in or entering secrets when the AI added a connector that needs
 * them (SSE `mcp_action_required`), and a connector's request for input (SSE `mcp_elicitation`). Text from a
 * connector (messages, field titles and descriptions) is untrusted and only ever rendered as plain text. */

const CARD = "w-full max-w-[560px] rounded-card bg-surface shadow-card";
const ENTER = { animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" };
const ACTION = "touch:h-11 touch:px-4";

/** The card frame: a quiet eyebrow naming what the card asks for (the title names the connector), an optional
 * status at the right, the title, then the body. */
function CardFrame({ eyebrow, status, title, children }: { eyebrow: string; status?: ReactNode; title: ReactNode; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={CARD} style={ENTER}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex min-h-6 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{eyebrow}</span>
          {status}
        </div>
        <h3 id={titleId} className="-mt-1 text-[14px] leading-[1.4] font-medium text-ink">{title}</h3>
        {children}
      </div>
    </section>
  );
}

function Actions({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
      {/* phones give the note its own row, so the 44px buttons stay on one line */}
      {note && <div className="mr-auto min-w-0 basis-full text-[12px] leading-[1.45] text-ink-2 sm:basis-auto">{note}</div>}
      {children}
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-[1.45] text-red-ink">
      <Icon name="danger" size={14} strokeWidth={2} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

function DoneLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-1.5 text-[13px] leading-[1.45] text-ink">
      <Icon name="success" size={15} strokeWidth={2} className="mt-px shrink-0 text-green-ink" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

const QUIET_TEXT = "text-[13px] leading-[1.5] text-ink-2";

function connectFailure(error: unknown, label: string, w: Words): string {
  if (error instanceof ApiError && error.code === "oauth_registration_required") {
    return w(`${label} needs an OAuth client registered by an administrator (Admin → Connectors).`,
      `${label} 需要管理员先在「管理 → 连接器」中登记 OAuth 客户端。`, `${label} 需要管理員先在「管理 → 連接器」中登記 OAuth 用戶端。`);
  }
  return errorText(error);
}

type ConnectState =
  | { step: "idle" | "connecting" | "checking" | "connected" | "closed" }
  | { step: "blocked"; url: string }
  | { step: "failed"; error: string };

function sourceText(source: McpActionConnector["source"], w: Words): string {
  return source === "ai" ? w("Added by the AI", "由 AI 添加", "由 AI 新增")
    : source === "import" ? w("Imported from a config file", "从配置导入", "從設定匯入")
      : w("Added by you", "手动添加", "手動新增");
}

/** Where the credentials would go, shown before any input: a connector's label is free text whoever adds it chooses
 * (an AI or an imported file can call an attacker's server "GitHub"), so the card names the destination itself, the
 * host of a remote connector or the command of a local one, and who added it. */
function Destination({ connector, w }: { connector: McpActionConnector; w: Words }) {
  const remote = connector.transport !== "stdio";
  let target = connector.destination;
  let plain = false;
  if (remote) {
    try {
      const url = new URL(connector.destination);
      target = url.host;
      plain = url.protocol === "http:";
    } catch {
      // shown as Platform sent it
    }
  }
  const heading = remote ? w("Keys and sign-in go to", "密钥和登录将发送到", "金鑰和登入將傳送到") : w("Keys go to this program on your computer", "密钥将交给你电脑上的这个程序", "金鑰將交給你電腦上的這個程式");
  return (
    <div role="group" aria-label={heading} className="flex min-w-0 flex-col gap-1.5 rounded-control bg-inset px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[12px] text-ink-2">{heading}</span>
        <StatusPill tone={connector.source === "manual" ? "neutral" : "orange"} dot={false} className="h-5.5 text-[12px]">{sourceText(connector.source, w)}</StatusPill>
      </div>
      <p translate="no" className="font-mono text-[14px] leading-[1.45] font-medium break-all text-ink">
        {target || w("Unknown address", "地址未知", "地址未知")}
      </p>
      {plain && <p className="text-[12px] text-orange-ink">{w("Not encrypted (http)", "未加密连接（http）", "未加密連線（http）")}</p>}
    </div>
  );
}

/** A connector the AI or an import added asks for nothing until the user confirms it (`POST …/confirm`). */
function ConfirmCard({ connector, label, onConfirm, onDismiss, w }: {
  connector: McpActionConnector;
  label: string;
  onConfirm: (connectorId: number) => Promise<void>;
  onDismiss: () => void;
  w: Words;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm(connector.id);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <CardFrame eyebrow={w("Confirm connector", "确认连接器", "確認連接器")} title={w(`Confirm ${label} before connecting it`, `连接前请确认 ${label}`, `連接前請確認 ${label}`)}>
      <Destination connector={connector} w={w} />
      <p className={QUIET_TEXT}>
        {connector.transport === "stdio"
          ? w(`The name “${label}” was chosen by whoever added it. Check the command above: once confirmed, it runs on your computer and receives the keys you enter.`,
            `名称「${label}」由添加者填写。请核对上面的命令：确认后它会在你的电脑上运行，并收到你填写的密钥。`,
            `名稱「${label}」由新增者填寫。請核對上面的命令：確認後它會在你的電腦上執行，並收到你填寫的金鑰。`)
          : w(`The name “${label}” was chosen by whoever added it. Check that the address above is the service you expect before you connect it or enter keys.`,
            `名称「${label}」由添加者填写。请确认上面的地址是你信任的服务，再连接或填写密钥。`,
            `名稱「${label}」由新增者填寫。請確認上面的地址是你信任的服務，再連接或填寫金鑰。`)}
      </p>
      {error && <ErrorLine>{error}</ErrorLine>}
      <Actions>
        <Button type="button" size="sm" variant="quiet" className={ACTION} disabled={busy} onClick={onDismiss}>{w("Not now", "稍后", "稍後")}</Button>
        <Button type="button" size="sm" variant="primary" className={ACTION} disabled={busy} aria-busy={busy || undefined} onClick={() => void confirm()}>
          {busy ? w("Confirming…", "正在确认…", "正在確認…") : w("Confirm and enable", "确认并启用", "確認並啟用")}
        </Button>
      </Actions>
    </CardFrame>
  );
}

/** SSE `mcp_action_required`. The destination and who added the connector come first; a connector the AI or an
 * import added must be confirmed (确认并启用) before anything else. Then 连接 opens the connector's OAuth sign-in in a
 * popup and waits for the callback page's `mcp-connected`; 填写密钥 opens a form whose values go straight to Platform
 * (`PUT …/credentials`), never into the conversation. `listScope` is the connector list that confirms a sign-in
 * whose popup closed without a message. */
export function McpActionCard({ action, listScope, onConfirm, onDismiss }: {
  action: McpActionRequired;
  listScope: "private" | "chat";
  onConfirm: (connectorId: number) => Promise<void>;
  onDismiss: () => void;
}) {
  const w = useWords();
  const { connector } = action;
  const label = connector.label || connector.name;
  if (connector.state === "pending_confirmation") return <ConfirmCard connector={connector} label={label} onConfirm={onConfirm} onDismiss={onDismiss} w={w} />;
  if (action.kind === "confirm") {
    // Confirmation was all this card asked for.
    return (
      <CardFrame eyebrow={w("Confirm connector", "确认连接器", "確認連接器")}
        status={<StatusPill tone="green" className="h-5.5 text-[12px]">{w("Enabled", "已启用", "已啟用")}</StatusPill>}
        title={w(`Confirm ${label} before connecting it`, `连接前请确认 ${label}`, `連接前請確認 ${label}`)}>
        <Destination connector={connector} w={w} />
        <DoneLine>{w(`${label} is confirmed and enabled. Tell the AI to continue.`, `已确认并启用 ${label}，告诉 AI 继续即可。`, `已確認並啟用 ${label}，告訴 AI 繼續即可。`)}</DoneLine>
        <Actions><Button type="button" size="sm" variant="quiet" className={ACTION} onClick={onDismiss}>{w("Close", "关闭", "關閉")}</Button></Actions>
      </CardFrame>
    );
  }
  return action.kind === "oauth"
    ? <OAuthCard connector={connector} label={label} listScope={listScope} onDismiss={onDismiss} w={w} />
    : <SecretsCard connector={connector} label={label} keys={action.keys ?? []} onDismiss={onDismiss} w={w} />;
}

function OAuthCard({ connector, label, listScope, onDismiss, w }: { connector: McpActionConnector; label: string; listScope: "private" | "chat"; onDismiss: () => void; w: Words }) {
  const [state, setState] = useState<ConnectState>({ step: "idle" });
  const connect = () => {
    // Called inside the click, so the popup opens before the request and popup blockers allow it.
    const flow = connectMcp(`/api/mcp/connectors/${connector.id}/connect`, connector.id);
    setState({ step: "connecting" });
    flow.then(async (result) => {
      if (result === "connected") return setState({ step: "connected" });
      // A closed popup may still have signed in (an identity provider can cut the message); the status decides.
      setState({ step: "checking" });
      const list = await request<McpConnectorList>(`/api/mcp/connectors?scope=${listScope}`).catch(() => null);
      setState({ step: list?.connectors.some((item) => item.id === connector.id && item.status === "connected") ? "connected" : "closed" });
    }, (error: unknown) => {
      setState(error instanceof McpPopupBlocked ? { step: "blocked", url: error.url } : { step: "failed", error: connectFailure(error, label, w) });
    });
  };
  const waiting = state.step === "connecting" || state.step === "checking" || state.step === "blocked";
  return (
    <CardFrame
      eyebrow={w("Connector sign-in", "连接器授权", "連接器授權")}
      status={state.step === "connected" ? <StatusPill tone="green" className="h-5.5 text-[12px]">{w("Connected", "已连接", "已連接")}</StatusPill> : undefined}
      title={w(`Connect ${label} so the AI can use it`, `连接 ${label}，AI 才能使用它`, `連接 ${label}，AI 才能使用它`)}
    >
      {state.step === "connected" ? (
        <>
          <DoneLine>{w(`${label} is connected. Tell the AI to continue.`, `已连接 ${label}，告诉 AI 继续即可。`, `已連接 ${label}，告訴 AI 繼續即可。`)}</DoneLine>
          <Actions><Button type="button" size="sm" variant="quiet" className={ACTION} onClick={onDismiss}>{w("Close", "关闭", "關閉")}</Button></Actions>
        </>
      ) : (
        <>
          <Destination connector={connector} w={w} />
          <p className={QUIET_TEXT}>
            {w("Sign in and approve access in the window that opens. The sign-in stays on the platform: the AI and the sandbox never see it.",
              "在弹出的窗口中登录并授权。登录凭据只保存在平台上，AI 和沙盒都看不到。", "在彈出的視窗中登入並授權。登入憑證只儲存在平台上，AI 和沙盒都看不到。")}
          </p>
          {state.step === "blocked" && (
            <p className={QUIET_TEXT}>
              {w("The browser blocked the window. ", "浏览器拦截了弹出窗口。", "瀏覽器攔截了彈出視窗。")}
              <a href={state.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink underline underline-offset-2">
                {w("Open the sign-in page", "打开登录页面", "開啟登入頁面")}
              </a>
            </p>
          )}
          {state.step === "closed" && <ErrorLine>{w("The sign-in window closed before access was approved.", "登录窗口已关闭，尚未完成授权。", "登入視窗已關閉，尚未完成授權。")}</ErrorLine>}
          {state.step === "failed" && <ErrorLine>{state.error}</ErrorLine>}
          <Actions note={waiting ? (state.step === "checking" ? w("Checking the connection…", "正在确认连接…", "正在確認連線…") : w("Waiting for you to finish signing in…", "等待你完成登录…", "等待你完成登入…")) : undefined}>
            <Button type="button" size="sm" variant="quiet" className={ACTION} onClick={onDismiss}>{w("Not now", "稍后", "稍後")}</Button>
            <Button type="button" size="sm" variant="primary" className={ACTION} disabled={waiting} aria-busy={waiting || undefined} onClick={connect}>
              {state.step === "closed" || state.step === "failed" ? w("Connect again", "重新连接", "重新連接") : w("Connect", "连接", "連接")}
            </Button>
          </Actions>
        </>
      )}
    </CardFrame>
  );
}

function SecretsCard({ connector, label, keys, onDismiss, w }: { connector: McpActionConnector; label: string; keys: string[]; onDismiss: () => void; w: Words }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (open) form.current?.querySelector("input")?.focus();
  }, [open]);
  const save = async () => {
    if (keys.some((key) => !values[key])) {
      setError(w("Enter every value.", "请填写所有密钥。", "請填寫所有金鑰。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveMcpSecrets(connector.id, Object.fromEntries(keys.map((key) => [key, values[key]])));
      setValues({});
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const names = keys.join("、");
  return (
    <CardFrame
      eyebrow={w("Connector keys", "连接器密钥", "連接器金鑰")}
      status={saved ? <StatusPill tone="green" className="h-5.5 text-[12px]">{w("Saved", "已保存", "已儲存")}</StatusPill> : undefined}
      title={w(`Enter the keys for ${label}`, `填写 ${label} 的密钥`, `填寫 ${label} 的金鑰`)}
    >
      {saved ? (
        <>
          <DoneLine>{w("The keys are saved. Tell the AI to continue.", "密钥已保存，告诉 AI 继续即可。", "金鑰已儲存，告訴 AI 繼續即可。")}</DoneLine>
          <Actions><Button type="button" size="sm" variant="quiet" className={ACTION} onClick={onDismiss}>{w("Close", "关闭", "關閉")}</Button></Actions>
        </>
      ) : !keys.length ? (
        <>
          <Destination connector={connector} w={w} />
          <p className={QUIET_TEXT}>
            {w(`${label} needs secret values. Enter them in `, `${label} 需要填写密钥，请在`, `${label} 需要填寫金鑰，請在`)}
            <a href="#settings/connectors" className="font-medium text-accent-ink underline underline-offset-2">{w("Settings → Connectors", "设置 → 连接器", "設定 → 連接器")}</a>
            {w(".", "中填写。", "中填寫。")}
          </p>
          <Actions><Button type="button" size="sm" variant="quiet" className={ACTION} onClick={onDismiss}>{w("Close", "关闭", "關閉")}</Button></Actions>
        </>
      ) : (
        <>
          <Destination connector={connector} w={w} />
          <p className={QUIET_TEXT}>
            {w(`Needs ${names}. Values go straight to the platform: they never appear in the conversation and the AI never sees them. Never paste keys into the chat.`,
              `需要 ${names}。密钥直接保存到平台，不会出现在对话里，AI 也看不到。请勿把密钥发到聊天中。`,
              `需要 ${names}。金鑰直接儲存到平台，不會出現在對話裡，AI 也看不到。請勿把金鑰貼到聊天中。`)}
          </p>
          {open ? (
            <form ref={form} id={formId} noValidate autoComplete="off" className="flex flex-col gap-3 border-t border-line pt-3"
              onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <SecretFields keys={keys} set={{}} values={values} onChange={setValues} disabled={busy} />
              {error && <ErrorLine>{error}</ErrorLine>}
              <Actions>
                <Button type="button" size="sm" variant="quiet" className={ACTION} disabled={busy} onClick={() => { setOpen(false); setValues({}); setError(""); }}>{w("Cancel", "取消", "取消")}</Button>
                <Button type="submit" size="sm" variant="primary" className={ACTION} disabled={busy} aria-busy={busy || undefined}>
                  {busy ? w("Saving…", "正在保存…", "正在儲存…") : w("Save", "保存", "儲存")}
                </Button>
              </Actions>
            </form>
          ) : (
            <Actions>
              <Button type="button" size="sm" variant="quiet" className={ACTION} onClick={onDismiss}>{w("Not now", "稍后", "稍後")}</Button>
              <Button type="button" size="sm" variant="primary" className={ACTION} onClick={() => setOpen(true)}>
                <Icon name="lock" size={14} />{w("Enter keys", "填写密钥", "填寫金鑰")}
              </Button>
            </Actions>
          )}
        </>
      )}
    </CardFrame>
  );
}

function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Milliseconds until `expiresAt`, ticking once a second while `active` and time remains. */
function useRemaining(expiresAt: string, active: boolean): number {
  const deadline = Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !Number.isFinite(deadline)) return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= deadline) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(timer);
  }, [active, deadline]);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : Number.POSITIVE_INFINITY;
}

function outcomeText(outcome: ElicitationOutcome, mine: boolean, w: Words): string {
  switch (outcome) {
    case "accept":
      return mine ? w("You answered", "已提交", "已提交") : w("Answered", "已回应", "已回應");
    case "decline":
      return w("Declined", "已拒绝", "已拒絕");
    case "cancel":
      return w("Cancelled", "已取消", "已取消");
    case "timeout":
      return w("Timed out", "已超时", "已逾時");
    case "gone":
      return w("No longer open", "请求已失效", "請求已失效");
  }
}

/** A link a connector asks the user to visit; only http(s). */
function safeUrl(raw: string | null | undefined): URL | null {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** SSE `mcp_elicitation`: the connector's message and, for the user who started the run, a form built from the
 * requested schema (提交 / 拒绝 / 取消) or a link to visit (已完成 / 取消), with the time left. Everyone else sees
 * that an answer is awaited. Platform cancels it when time runs out; nothing is ever answered automatically. */
export function ElicitationCard({ state, mine, onAnswer }: {
  state: ElicitationState;
  /** this viewer started the run and may answer */
  mine: boolean;
  onAnswer: (id: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => Promise<void>;
}) {
  const w = useWords();
  const { request: ask, outcome } = state;
  const remaining = useRemaining(ask.expires_at, outcome === null);
  const expired = outcome === null && remaining === 0;
  const settled = outcome ?? (expired ? "timeout" : null);
  const label = ask.connector.label || ask.connector.name;
  const timer = settled ? (
    <StatusPill tone={settled === "accept" ? "green" : "neutral"} className="h-5.5 text-[12px]">{outcomeText(settled, mine, w)}</StatusPill>
  ) : Number.isFinite(remaining) ? (
    <StatusPill tone={remaining <= 60_000 ? "orange" : "neutral"} dot={false} className="h-5.5 gap-1 text-[12px] tabular-nums">
      <Icon name="clock" size={12} strokeWidth={2.2} />
      <span role="timer" aria-label={w(`Time left ${clock(remaining)}`, `剩余时间 ${clock(remaining)}`, `剩餘時間 ${clock(remaining)}`)}>{clock(remaining)}</span>
    </StatusPill>
  ) : undefined;
  return (
    <CardFrame eyebrow={w("Connector request", "连接器请求", "連接器請求")} status={timer}
      title={ask.mode === "url" ? w(`${label} asks you to open a link`, `${label} 请你打开一个链接`, `${label} 請你開啟一個連結`) : w(`${label} needs some information`, `${label} 需要你提供信息`, `${label} 需要你提供資訊`)}>
      <p className={cn("whitespace-pre-wrap break-words text-[13.5px] leading-[1.55] text-ink", settled && "line-clamp-3 text-ink-2")}>{ask.message}</p>
      {settled ? null : !mine ? (
        <p className={QUIET_TEXT}>{w("Waiting for the person who started this run to answer.", "等待发起本次任务的成员回应。", "等待發起本次任務的成員回應。")}</p>
      ) : ask.mode === "url" ? (
        <UrlAnswer id={ask.id} url={ask.url} onAnswer={onAnswer} w={w} />
      ) : (
        <FormAnswer id={ask.id} schema={ask.schema} onAnswer={onAnswer} w={w} />
      )}
    </CardFrame>
  );
}

/** Answers with one of the three actions and keeps the buttons busy meanwhile; a failure shows in the card. */
function useAnswer(id: string, onAnswer: (id: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => Promise<void>, w: Words) {
  const [busy, setBusy] = useState<"accept" | "decline" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const answer = async (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => {
    setBusy(action);
    setError("");
    try {
      await onAnswer(id, action, content);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "elicitation_forbidden"
        ? w("Only the person who started this run can answer.", "只有发起本次任务的成员可以回应。", "只有發起本次任務的成員可以回應。")
        : errorText(cause));
      setBusy(null);
    }
  };
  return { busy, error, answer };
}

function UrlAnswer({ id, url, onAnswer, w }: { id: string; url?: string | null; onAnswer: (id: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => Promise<void>; w: Words }) {
  const { busy, error, answer } = useAnswer(id, onAnswer, w);
  const target = safeUrl(url);
  return (
    <>
      {target ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-inset px-3 py-2.5">
          <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
            {w("Opens ", "将打开 ", "將開啟 ")}
            <span className="font-mono text-[12.5px] break-all text-ink">{target.host}</span>
          </span>
          <a href={target.href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "secondary", size: "sm" }), ACTION)}>
            {w("Open link", "打开链接", "開啟連結")}<Icon name="external" size={13} />
          </a>
        </div>
      ) : (
        <ErrorLine>{w("The connector sent a link that cannot be opened.", "连接器发来的链接无法打开。", "連接器傳來的連結無法開啟。")}</ErrorLine>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      <Actions note={target ? w("Choose Done after you finish on that page.", "在该页面完成后，点「已完成」。", "在該頁面完成後，點「已完成」。") : undefined}>
        <Button type="button" size="sm" variant="quiet" className={ACTION} disabled={busy !== null} onClick={() => void answer("cancel")}>{w("Cancel", "取消", "取消")}</Button>
        {target && (
          <Button type="button" size="sm" variant="primary" className={ACTION} disabled={busy !== null} aria-busy={busy === "accept" || undefined} onClick={() => void answer("accept")}>
            {w("Done", "已完成", "已完成")}
          </Button>
        )}
      </Actions>
    </>
  );
}

const INPUT_TYPES = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" } as const;

function FieldControl({ field, value, onChange, disabled, w }: { field: SchemaField; value: FormValues[string]; onChange: (value: FormValues[string]) => void; disabled: boolean; w: Words }) {
  switch (field.kind) {
    case "boolean":
      return <Switch checked={value === true} onChange={onChange} label={field.title} disabled={disabled} />;
    case "enum":
      return <Select value={typeof value === "string" ? value : ""} onChange={onChange} options={field.options} disabled={disabled} required={field.required}
        placeholder={w("Choose…", "请选择…", "請選擇…")} />;
    case "multi":
      return <MultiSelect values={Array.isArray(value) ? value : []} onChange={onChange} options={field.options} disabled={disabled} required={field.required}
        placeholder={w("Choose…", "请选择…", "請選擇…")} />;
    case "number":
    case "integer":
      return <TextField inputMode={field.kind === "integer" ? "numeric" : "decimal"} autoComplete="off" disabled={disabled} value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)} />;
    case "string":
      return field.format === null && (field.maxLength ?? 0) > 200
        ? <TextArea rows={2} maxRows={8} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />
        : <TextField type={field.format ? INPUT_TYPES[field.format] : "text"} autoComplete="off" disabled={disabled} value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)} />;
  }
}

/** The schema's limits as a hint under the field, after its own description. */
function fieldHint(field: SchemaField, w: Words): string {
  const limits = field.kind === "number" || field.kind === "integer"
    ? field.minimum !== null && field.maximum !== null ? `${field.minimum}–${field.maximum}`
      : field.minimum !== null ? w(`At least ${field.minimum}`, `不小于 ${field.minimum}`, `不小於 ${field.minimum}`)
        : field.maximum !== null ? w(`At most ${field.maximum}`, `不大于 ${field.maximum}`, `不大於 ${field.maximum}`) : ""
    : field.kind === "string" && field.maxLength !== null ? w(`Up to ${field.maxLength} characters`, `最多 ${field.maxLength} 个字符`, `最多 ${field.maxLength} 個字元`) : "";
  return [field.description, limits].filter(Boolean).join(" · ");
}

function FormAnswer({ id, schema, onAnswer, w }: { id: string; schema?: Record<string, unknown> | null; onAnswer: (id: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => Promise<void>; w: Words }) {
  const parsed = useMemo(() => parseSchema(schema), [schema]);
  const [values, setValues] = useState<FormValues>(() => initialValues(parsed.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, answer } = useAnswer(id, onAnswer, w);
  const formId = useId();
  // A required property this form cannot draw (a nested object) leaves only declining or cancelling.
  const answerable = !parsed.unsupported.some((property) => property.required);
  const submit = () => {
    const result = formContent(parsed.fields, values, w);
    if (!result.ok) {
      setErrors(result.errors);
      const first = parsed.fields.findIndex((field) => result.errors[field.key]);
      document.getElementById(`${formId}-${first}`)?.focus();
      return;
    }
    setErrors({});
    void answer("accept", result.content);
  };
  const disabled = busy !== null;
  return (
    <form noValidate autoComplete="off" className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (answerable) submit(); }}>
      {parsed.fields.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          {parsed.fields.map((field, index) => {
            const control = (
              <FieldControl field={field} value={values[field.key]} disabled={disabled} w={w}
                onChange={(value) => {
                  setValues((current) => ({ ...current, [field.key]: value }));
                  if (errors[field.key]) setErrors((current) => ({ ...current, [field.key]: "" }));
                }} />
            );
            // A switch sits beside its label and description, the way settings rows read.
            return field.kind === "boolean" ? (
              <div key={field.key} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-ink">{field.title}</p>
                  {field.description && <p className="mt-0.5 text-[12px] leading-[1.4] text-ink-2">{field.description}</p>}
                </div>
                {control}
              </div>
            ) : (
              <Field key={field.key} id={`${formId}-${index}`} label={field.title} required={field.required} hint={fieldHint(field, w) || undefined} error={errors[field.key] || undefined}>
                {control}
              </Field>
            );
          })}
        </div>
      )}
      {!answerable && (
        <ErrorLine>{w("This request asks for information this form cannot show. You can decline it or cancel.", "此请求需要的信息无法在表单中填写，你可以拒绝或取消。", "此請求需要的資訊無法在表單中填寫，你可以拒絕或取消。")}</ErrorLine>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      <Actions note={w("Your answer goes only to this connector.", "你的回答只会发给该连接器。", "你的回答只會傳給該連接器。")}>
        <Button type="button" size="sm" variant="quiet" className={ACTION} disabled={disabled} aria-busy={busy === "cancel" || undefined} onClick={() => void answer("cancel")}>{w("Cancel", "取消", "取消")}</Button>
        <Button type="button" size="sm" variant="secondary" className={ACTION} disabled={disabled} aria-busy={busy === "decline" || undefined} onClick={() => void answer("decline")}>{w("Decline", "拒绝", "拒絕")}</Button>
        {answerable && (
          <Button type="submit" size="sm" variant="primary" className={ACTION} disabled={disabled} aria-busy={busy === "accept" || undefined}>
            {busy === "accept" ? w("Submitting…", "正在提交…", "正在提交…") : w("Submit", "提交", "提交")}
          </Button>
        )}
      </Actions>
    </form>
  );
}
