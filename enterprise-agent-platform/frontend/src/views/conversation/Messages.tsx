import { ComputerOutput, Glyph, MessageEntry, Spinner, StatusMark, type GlyphName } from "../../components/ui/fieldwork";
import { useWords } from "../../words";
import { AttachmentItem } from "./Attachments";
import { Markdown } from "./Markdown";
import type { LiveRun, Message, ToolActivity } from "./types";

type Words = (en: string, zhCN?: string, zhTW?: string) => string;

/** `MEDIA: /workspace/x` lines stay in stored text; the attachment card replaces the ones it delivered. */
function visibleContent(message: Message): string {
  if (!message.attachments.length) return message.content;
  const names = new Set(message.attachments.map((attachment) => attachment.filename));
  return message.content
    .split("\n")
    .filter((line) => {
      const media = /^\s*MEDIA:\s*(\S.*?)\s*$/.exec(line);
      return !media || !names.has(media[1].split("/").pop() ?? "");
    })
    .join("\n")
    .trim();
}

function author(message: Message): string | null {
  const name = message.metadata.author_display_name;
  return typeof name === "string" && name ? name : null;
}

function StoredActivity({ work }: { work: unknown }) {
  const w = useWords();
  if (!work || typeof work !== "object" || !("activity" in work) || !Array.isArray(work.activity)) return null;
  return <div aria-label={w("Recorded activity", "已记录的活动", "已記錄的活動")}>
    {work.activity.map((entry: unknown, index: number) => {
      if (!entry || typeof entry !== "object" || !("stage" in entry)) return null;
      const detail = "detail" in entry && typeof entry.detail === "string" ? entry.detail : "";
      const line = "line" in entry && typeof entry.line === "string" ? entry.line : "";
      if (entry.stage === "assistant.message") return <Markdown key={index} content={detail || line} />;
      if (entry.stage === "work.truncated") return <p key={index} className="cv-footnote">
        {w("Earlier activity was omitted", "部分早期活动已省略", "部分早期活動已省略")}
        {"omitted_events" in entry && typeof entry.omitted_events === "number" ? ` (${entry.omitted_events})` : ""}
      </p>;
      if (entry.stage !== "tool" || !("tool" in entry) || typeof entry.tool !== "string") return null;
      const status = "tool_status" in entry ? entry.tool_status : null;
      const statusLabel = status === "completed" ? w("Completed", "已完成", "已完成")
        : status === "failed" ? w("Failed", "失败", "失敗")
          : status === "running" ? w("Recorded as running", "记录为运行中", "記錄為執行中") : "";
      const parameters = "parameters" in entry && entry.parameters && typeof entry.parameters === "object"
        ? JSON.stringify(entry.parameters, null, 2) : "";
      const result = "result" in entry && typeof entry.result === "string" ? entry.result : "";
      return <details className="cv-tool" key={index}>
        <summary>
          <Glyph name="terminal" size={16} />
          <span className="cv-tool-label">{entry.tool}</span>
          {(detail || line) && <span className="cv-tool-summary wf-mono">{detail || line}</span>}
          {statusLabel && <StatusMark subtle tone={status === "failed" ? "danger" : "neutral"}>{statusLabel}</StatusMark>}
        </summary>
        {(parameters || result) && <ComputerOutput kind="terminal"><pre>{[parameters, result].filter(Boolean).join("\n\n")}</pre></ComputerOutput>}
      </details>;
    })}
  </div>;
}

export function MessageView({ message, showAuthor }: { message: Message; showAuthor: boolean }) {
  const w = useWords();
  const status = message.metadata.status;
  const content = visibleContent(message);
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const name = showAuthor && message.role === "user" ? author(message) : null;
  return (
    <MessageEntry
      kind={message.role === "assistant" ? "agent" : message.role}
      header={name ? <span className="wf-message-author">{name}</span> : undefined}
      work={message.role === "assistant" && message.metadata.agent_work ? <StoredActivity work={message.metadata.agent_work} /> : undefined}
      attachments={message.attachments.length ? message.attachments.map((attachment) => <AttachmentItem key={attachment.id} attachment={attachment} />) : undefined}
      footnote={
        <span className="cv-footnote">
          <time className="wf-message-time" dateTime={message.created_at}>{time}</time>
          {status === "queued" && <StatusMark subtle>{w("Queued", "排队中", "排隊中")}</StatusMark>}
          {status === "running" && <StatusMark subtle busy>{w("In progress", "处理中", "處理中")}</StatusMark>}
          {status === "cancelled" && <StatusMark subtle>{w("Stopped", "已停止", "已停止")}</StatusMark>}
          {status === "interrupted" && <StatusMark tone="warning" subtle>{w("Interrupted — send again to retry", "已中断，可重新发送", "已中斷，可重新傳送")}</StatusMark>}
          {typeof message.metadata.error === "string" && message.metadata.error && <span className="cv-error-text">{message.metadata.error}</span>}
        </span>
      }
    >
      {message.role === "assistant" ? <Markdown content={content} /> : <div className="cv-plain">{content}</div>}
    </MessageEntry>
  );
}

function argText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function describeTool(tool: ToolActivity, w: Words): { glyph: GlyphName; kind: "file" | "terminal" | "search"; label: string; summary: string; input: string } {
  const { args } = tool;
  const path = argText(args, "path");
  switch (tool.name) {
    case "bash":
      return { glyph: "terminal", kind: "terminal", label: w("Ran command", "运行命令", "執行命令"), summary: argText(args, "command"), input: `$ ${argText(args, "command")}` };
    case "write":
      return { glyph: "file", kind: "file", label: w("Wrote file", "写入文件", "寫入檔案"), summary: path, input: argText(args, "content") };
    case "edit":
      return { glyph: "file", kind: "file", label: w("Edited file", "编辑文件", "編輯檔案"), summary: path, input: JSON.stringify(args.edits ?? { oldText: args.oldText, newText: args.newText }, null, 2) };
    case "read":
      return { glyph: "file", kind: "file", label: w("Read file", "读取文件", "讀取檔案"), summary: path, input: "" };
    case "ls":
    case "find":
    case "grep":
      return { glyph: "search", kind: "file", label: w("Searched files", "查找文件", "尋找檔案"), summary: [argText(args, "pattern"), path].filter(Boolean).join("  "), input: "" };
    case "web_search":
      return { glyph: "search", kind: "search", label: w("Searched the web", "搜索网页", "搜尋網頁"), summary: argText(args, "query"), input: "" };
    case "web_fetch":
      return { glyph: "browser", kind: "search", label: w("Opened page", "打开网页", "開啟網頁"), summary: argText(args, "url"), input: "" };
    case "browser":
      return { glyph: "browser", kind: "search", label: w("Used browser", "使用浏览器", "使用瀏覽器"), summary: [argText(args, "action"), argText(args, "url")].filter(Boolean).join("  "), input: "" };
    case "schedule":
      return { glyph: "schedule", kind: "terminal", label: w("Schedules", "定时任务", "排程任務"), summary: argText(args, "action"), input: JSON.stringify(args, null, 2) };
    default:
      return { glyph: "sparkle", kind: "terminal", label: tool.name, summary: [argText(args, "server"), argText(args, "tool")].filter(Boolean).join(" · "), input: JSON.stringify(args, null, 2) };
  }
}

function ToolRow({ tool }: { tool: ToolActivity }) {
  const w = useWords();
  const view = describeTool(tool, w);
  const body = [view.input, tool.output].filter(Boolean).join("\n\n");
  return (
    <details className="cv-tool">
      <summary>
        <Glyph name={view.glyph} size={16} />
        <span className="cv-tool-label">{view.label}</span>
        {view.summary && <span className="cv-tool-summary wf-mono">{view.summary}</span>}
        {tool.state === "running" && <StatusMark subtle busy>{w("Running", "进行中", "進行中")}</StatusMark>}
        {tool.state === "error" && <StatusMark tone="danger" subtle>{w("Failed", "失败", "失敗")}</StatusMark>}
      </summary>
      {body ? <ComputerOutput kind={view.kind}><pre>{body}</pre></ComputerOutput> : null}
    </details>
  );
}

export function LiveRunView({ run }: { run: LiveRun }) {
  const w = useWords();
  const hasText = run.items.some((item) => item.kind === "text" && item.text);
  const status = run.notice === "retry" ? w("Connection hiccup, retrying…", "连接波动，正在重试…", "連線不穩，正在重試…")
    : run.notice === "compaction" ? w("Compacting context…", "正在压缩上下文…", "正在壓縮上下文…")
      : hasText ? null : w("Working…", "处理中…", "處理中…");
  return (
    <MessageEntry kind="agent" streaming label={w("Reply in progress", "回复生成中", "回覆產生中")}>
      {run.thinking && (
        <details className="cv-thinking">
          <summary>{w("Thinking", "思考过程", "思考過程")}</summary>
          <div className="cv-plain">{run.thinking}</div>
        </details>
      )}
      {run.items.map((item, index) => item.kind === "tool"
        ? <ToolRow key={item.id} tool={item} />
        : <Markdown key={`text-${index}`} content={item.text} />)}
      {status && <div className="cv-working" role="status"><Spinner size={14} />{status}</div>}
    </MessageEntry>
  );
}
