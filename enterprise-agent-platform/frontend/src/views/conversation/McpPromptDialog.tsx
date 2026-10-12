import { useId, useRef, useState } from "react";
import { ApiError, request, type McpPrompt, type McpPromptRender } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { Dialog, Field, Notice, TextArea } from "../../components/ui/beautiful/controls";
import { useWords } from "../../words";
import { errorText } from "./useConversation";
import type { Words } from "./work";

/** Renders an MCP prompt through Platform (`POST /api/mcp/prompts/render`) and returns its text for the composer. */
export async function renderMcpPrompt(scope: string, prompt: McpPrompt, args: Record<string, string>): Promise<string> {
  return (await request<McpPromptRender>("/api/mcp/prompts/render", {
    method: "POST",
    body: JSON.stringify({ scope, connector: prompt.connector, name: prompt.name, arguments: args }),
  })).text;
}

/** Why a prompt could not be rendered. A connector refusing its sign-in (409 `needs_auth`) or keys (409
 * `credentials_rejected`) points to where the user fixes it. */
export function promptFailure(cause: unknown, prompt: McpPrompt, w: Words): string {
  const label = prompt.connector_label || prompt.connector;
  if (cause instanceof ApiError && cause.code === "needs_auth") {
    return w(`${label} needs to be connected again. Reconnect it in Settings → Connectors, then try again.`,
      `${label} 需要重新连接。请在「设置 → 连接器」中重新连接后再试。`, `${label} 需要重新連接。請在「設定 → 連接器」中重新連接後再試。`);
  }
  if (cause instanceof ApiError && cause.code === "credentials_rejected") {
    return w(`${label} rejected its keys. Update them in Settings → Connectors, then try again.`,
      `${label} 拒绝了已保存的密钥。请在「设置 → 连接器」中更新后再试。`, `${label} 拒絕了已儲存的金鑰。請在「設定 → 連接器」中更新後再試。`);
  }
  return errorText(cause);
}

/** The argument form of an MCP prompt picked from the composer's `/` menu. Inserting renders the prompt and hands
 * its text to the composer; nothing is sent. */
export function McpPromptDialog({ prompt, scope, onInsert, onClose }: {
  prompt: McpPrompt;
  /** the conversation scope the prompt is rendered for */
  scope: string;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const w = useWords();
  const id = useId();
  const first = useRef<HTMLTextAreaElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  const insert = async () => {
    const absent = new Set(prompt.arguments.filter((arg) => arg.required && !values[arg.name]?.trim()).map((arg) => arg.name));
    setMissing(absent);
    if (absent.size) {
      document.getElementById(`${id}-${prompt.arguments.findIndex((arg) => absent.has(arg.name))}`)?.focus();
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      // Empty optional arguments are left out, so the server applies its own defaults.
      onInsert(await renderMcpPrompt(scope, prompt, Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))));
    } catch (cause) {
      setFailure(promptFailure(cause, prompt, w));
      setBusy(false);
    }
  };

  const command = `/${prompt.connector}:${prompt.name}`;
  return (
    <Dialog
      open
      size="sm"
      onClose={() => { if (!busy) onClose(); }}
      title={prompt.title || command}
      description={<>
        <span className="block">{prompt.description || w(`A prompt from ${prompt.connector_label}.`, `来自 ${prompt.connector_label} 的提示词。`, `來自 ${prompt.connector_label} 的提示詞。`)}</span>
        <span className="mt-1 block font-mono text-[12px] text-ink-2">{command}</span>
      </>}
      initialFocusRef={first}
      footer={<>
        <Button type="button" size="sm" variant="secondary" className="touch:h-11 touch:px-4" disabled={busy} onClick={onClose}>{w("Cancel", "取消", "取消")}</Button>
        <Button type="submit" form={`${id}-form`} size="sm" variant="primary" className="touch:h-11 touch:px-4" disabled={busy} aria-busy={busy || undefined}>
          {busy ? w("Inserting…", "正在插入…", "正在插入…") : w("Insert", "插入", "插入")}
        </Button>
      </>}
    >
      <form id={`${id}-form`} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void insert(); }}>
        {prompt.arguments.map((arg, index) => (
          <Field key={arg.name} id={`${id}-${index}`} label={<span className="font-mono text-[12.5px]">{arg.name}</span>} required={Boolean(arg.required)}
            hint={arg.description || undefined} error={missing.has(arg.name) ? w("Required", "必填", "必填") : undefined}>
            <TextArea ref={index === 0 ? first : undefined} rows={1} maxRows={6} disabled={busy} value={values[arg.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [arg.name]: event.target.value }))}
              onKeyDown={(event) => {
                // Enter inserts like a single-line field; Shift+Enter keeps a line break for longer arguments.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} />
          </Field>
        ))}
        {failure && <Notice tone="danger" title={w("The prompt could not be loaded", "无法获取提示词", "無法取得提示詞")}>{failure}</Notice>}
      </form>
    </Dialog>
  );
}
