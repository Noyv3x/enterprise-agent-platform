import { useId, useState } from "react";
import { request, type McpDetectedFile, type McpImportResult } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { SegmentedControl } from "../../components/ui/beautiful/atoms/SegmentedControl";
import { Dialog, Field, Icon, Notice, TextArea } from "../../components/ui/beautiful/controls";
import { cn } from "../../components/ui/beautiful/cn";
import { useWords } from "../../words";

type Mode = "paste" | "file";

/** Imports connectors from another tool's MCP setup (POST /api/mcp/import): a pasted `claude mcp add …` /
 * `codex mcp add …` line or config snippet, or a config file found in the personal workspace. Literal keys in the
 * snippet are moved to the platform's secret store; what is still missing is listed for the user to complete. */
export function ImportDialog({ open, onClose, detected, initialPath, onImported }: {
  open: boolean;
  onClose: () => void;
  detected: McpDetectedFile[];
  /** preselects a detected file */
  initialPath?: string | null;
  onImported: (result: McpImportResult) => void;
}) {
  const w = useWords();
  const id = useId();
  const [mode, setMode] = useState<Mode>(initialPath ? "file" : "paste");
  const [text, setText] = useState("");
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<McpImportResult | null>(null);
  const modes: Record<Mode, string> = { paste: w("Paste", "粘贴配置", "貼上設定"), file: w("Workspace file", "工作区文件", "工作區檔案") };
  const ready = mode === "paste" ? text.trim() !== "" : path !== null;

  const finish = () => { setText(""); setError(""); setResult(null); setMode("paste"); setPath(null); onClose(); };

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await request<McpImportResult>("/api/mcp/import", { method: "POST", body: JSON.stringify(mode === "paste" ? { text } : { path }) });
      setResult(next);
      onImported(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} size="lg" onClose={() => { if (!busy) finish(); }}
    title={w("Import connectors", "导入连接器", "匯入連接器")}
    description={result ? undefined : w("From Claude Code, Claude Desktop, Codex, Cursor, VS Code or OpenCode. Keys found in it are stored on the platform, never in your workspace.", "支持 Claude Code、Claude Desktop、Codex、Cursor、VS Code 和 OpenCode 的配置。其中的密钥会保存到平台上，不会留在工作区。", "支援 Claude Code、Claude Desktop、Codex、Cursor、VS Code 和 OpenCode 的設定。其中的金鑰會儲存到平台上，不會留在工作區。")}
    footer={result
      ? <Button size="sm" variant="primary" className="touch:h-11 touch:px-4" onClick={finish}>{w("Done", "完成", "完成")}</Button>
      : <>
        <Button size="sm" variant="secondary" className="touch:h-11 touch:px-4" disabled={busy} onClick={finish}>{w("Cancel", "取消", "取消")}</Button>
        <Button size="sm" variant="primary" type="submit" form={`${id}-form`} className="touch:h-11 touch:px-4" disabled={!ready || busy} aria-busy={busy || undefined}>
          {busy ? w("Importing…", "正在导入…", "正在匯入…") : w("Import", "导入", "匯入")}
        </Button>
      </>}>
    {result ? <ImportSummary result={result} /> : <form id={`${id}-form`} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {detected.length > 0 && <SegmentedControl options={[modes.paste, modes.file]} value={modes[mode]} className="w-full touch:h-11"
        onChange={(label) => { setMode(label === modes.file ? "file" : "paste"); setError(""); }} />}
      {mode === "paste" ? (
        <Field label={w("Install instructions or config", "安装命令或配置", "安裝命令或設定")} id={`${id}-text`}
          hint={w("A claude mcp add or codex mcp add command, or the mcpServers / [mcp_servers] part of a config file.", "一条 claude mcp add 或 codex mcp add 命令，或配置文件中的 mcpServers / [mcp_servers] 部分。", "一條 claude mcp add 或 codex mcp add 命令，或設定檔中的 mcpServers / [mcp_servers] 部分。")}>
          <TextArea value={text} rows={6} maxRows={16} spellCheck={false} disabled={busy} className="font-mono text-[12.5px]"
            placeholder={'claude mcp add --transport http notion https://mcp.notion.com/mcp\n\n{ "mcpServers": { "github": { "url": "https://api.githubcopilot.com/mcp/" } } }'}
            onChange={(event) => { setText(event.target.value); setError(""); }} />
        </Field>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[12.5px] font-medium text-ink">{w("Config file", "配置文件", "設定檔")}</legend>
          {detected.map((file) => (
            <label key={file.path} className={cn("flex cursor-pointer items-start gap-3 rounded-card px-3 py-2.5 shadow-card transition-colors duration-100 touch:min-h-11",
              path === file.path ? "bg-accent-tint" : "bg-surface hover:bg-inset")}>
              <input type="radio" name={`${id}-file`} className="mt-1 accent-[var(--accent)]" checked={path === file.path} disabled={busy} onChange={() => { setPath(file.path); setError(""); }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12.5px] text-ink">{file.path}</span>
                <span className="block text-[12px] text-ink-2">{w(`${file.format} · ${file.servers.join(", ")}`, `${file.format} · ${file.servers.join("、")}`, `${file.format} · ${file.servers.join("、")}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {error && <Notice tone="danger" title={w("Nothing was imported", "没有导入任何连接器", "沒有匯入任何連接器")}>{error}</Notice>}
    </form>}
  </Dialog>;
}

/** What was created, what each connector still needs, and what was skipped and why. */
function ImportSummary({ result }: { result: McpImportResult }) {
  const w = useWords();
  const need = (name: string) => result.missing.filter((item) => item.connector === name);
  const skipped = (result.skipped ?? []).map((item) => (typeof item === "string" ? { name: item, reason: "" } : item));
  const reasons: Record<string, string> = {
    exists: w("a connector with this name already exists", "已有同名连接器", "已有同名連接器"),
    local_not_allowed: w("local programs are only for the personal AI", "本地程序只能在个人 AI 中使用", "本機程式只能在個人 AI 中使用"),
    invalid: w("the entry is not a valid connector", "这一项不是有效的连接器配置", "這一項不是有效的連接器設定"),
  };
  // An invalid entry's message says what is wrong with it; the other reasons read better in our words.
  const reason = (item: { reason: string; message?: string | null }) =>
    (item.reason === "invalid" && item.message) || reasons[item.reason] || item.message || item.reason;
  return <div className="flex flex-col gap-3">
    {result.connectors.length > 0
      ? <Notice tone="success" title={w(`Imported ${result.connectors.length} connector(s)`, `已导入 ${result.connectors.length} 个连接器`, `已匯入 ${result.connectors.length} 個連接器`)}>
        {result.connectors.some((connector) => connector.status === "pending_confirmation")
          ? w("Check where each one connects and confirm it in the list; your AI cannot use it before that.", "请在列表中查看每个连接器连接到哪里并确认，确认前 AI 不能使用它。", "請在清單中查看每個連接器連到哪裡並確認，確認前 AI 不能使用它。")
          : result.missing.length > 0 && w("Some still need a sign-in or keys; open them in the list to finish.", "部分连接器还需要登录或填写密钥，请在列表中打开它们完成设置。", "部分連接器還需要登入或填寫金鑰，請在清單中開啟它們完成設定。")}
      </Notice>
      : <Notice tone={skipped.length ? "warning" : "info"} title={skipped.length ? w("Nothing new was imported", "没有导入新的连接器", "沒有匯入新的連接器") : w("No connectors were found in it", "没有找到可导入的连接器", "沒有找到可匯入的連接器")} />}
    {result.connectors.length > 0 && <ul className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
      {result.connectors.map((connector) => (
        <li key={connector.id} className="flex flex-col gap-1 border-b border-line px-4 py-2.5 last:border-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{connector.label || connector.name}</span>
            <span className="font-mono text-[12px] text-ink-2">{connector.name}</span>
          </span>
          {need(connector.name).map((item) => (
            <span key={item.kind} className="flex items-center gap-1.5 text-[12px] text-orange-ink">
              <Icon name={item.kind === "oauth" ? "external" : "lock"} size={12} />
              {item.kind === "oauth" ? w("Needs sign-in", "需要登录", "需要登入")
                : w(`Needs keys: ${(item.keys ?? []).join(", ")}`, `需要填写密钥：${(item.keys ?? []).join("、")}`, `需要填寫金鑰：${(item.keys ?? []).join("、")}`)}
            </span>
          ))}
        </li>
      ))}
    </ul>}
    {skipped.length > 0 && <section aria-label={w("Skipped", "已跳过", "已略過")} className="flex flex-col gap-1.5">
      <h3 className="px-1 text-[12.5px] font-medium text-ink">{w(`Skipped ${skipped.length}`, `跳过 ${skipped.length} 个`, `略過 ${skipped.length} 個`)}</h3>
      <ul className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
        {skipped.map((item) => (
          <li key={item.name} className="flex flex-wrap items-baseline gap-x-2 border-b border-line px-4 py-2 last:border-0">
            <span className="font-mono text-[12.5px] text-ink">{item.name}</span>
            {reason(item) && <span className="text-[12px] text-ink-2">{reason(item)}</span>}
          </li>
        ))}
      </ul>
    </section>}
  </div>;
}
