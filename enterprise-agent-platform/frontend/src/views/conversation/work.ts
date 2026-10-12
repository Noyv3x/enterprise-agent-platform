import { createContext } from "react";
import type { Message } from "./types";

/** One entry of an assistant turn's work, in arrival order (platform-api.md § Assistant message work trace). */
export type WorkItem =
  | { type: "thinking"; text: string; startedAt: number | null; endedAt: number | null }
  | { type: "text"; text: string }
  | { type: "input"; messageId: number; at: number | null }
  /** a plain status line from old `agent_work` records */
  | { type: "step"; label: string; detail: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "done" | "error" | "cancelled";
      output: string;
      startedAt: number | null;
      endedAt: number | null;
      /** the background task (`bg-<n>`) a promoted command keeps running as */
      background?: string;
    };

export interface WorkTrace {
  items: WorkItem[];
  /** epoch ms; null when the record carries no times */
  startedAt: number | null;
  endedAt: number | null;
  truncated: boolean;
  /** old records count events the previous system dropped */
  omitted: number;
}

export type Words = (en: string, zhCN?: string, zhTW?: string) => string;

/** Connector labels by connector name (`GET /api/mcp/prompts` `connectors`), for MCP rows; a connector without one
 * reads as its name. */
export type McpLabels = Record<string, string>;
export const McpLabelsContext = createContext<McpLabels>({});

/** `mcp__<connector>__<tool>`: connector names never contain `_`, so the first `__` after the prefix splits them. */
export function mcpToolName(name: string): { connector: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const at = rest.indexOf("__");
  return at > 0 && at + 2 < rest.length ? { connector: rest.slice(0, at), tool: rest.slice(at + 2) } : null;
}

/** The `mcp` tool's action. Traces of the removed per-call helper carried `{server, tool}` without one: a call. */
function mcpAction(args: Record<string, unknown> | undefined): string {
  return typeof args?.action === "string" ? args.action : args?.tool ? "call" : "list";
}

/** What an `mcp` tool call is about: 「<label> · <tool>」 for a call or a schema, the resource URI, the connector's
 * label, or the imported file. */
export function mcpSubject(args: Record<string, unknown>, labels: McpLabels): string {
  const text = (key: string) => (typeof args[key] === "string" ? args[key] as string : "");
  const proxied = mcpToolName(text("name"));
  const connector = proxied?.connector || text("connector") || text("server") || (mcpAction(args) === "call" ? "" : text("name"));
  const label = connector ? labels[connector] || connector : "";
  const tool = proxied?.tool || text("tool");
  switch (mcpAction(args)) {
    case "call":
    case "describe":
      return [label, tool].filter(Boolean).join(" · ") || text("name");
    case "read_resource":
      return text("uri") || label;
    case "import":
      return text("path");
    case "add":
      return text("label") || label;
    default:
      return label;
  }
}

/** The verb a tool call reads as; the conversation's work trace and the computer panel share it. `args` refines
 * the `job`, `skill`, `artifact` and `mcp` verbs by their action. A connector's tool (`mcp__<connector>__<tool>`)
 * reads as a whole phrase, 「调用 <label> · <tool>」, with `labels` naming the connector. */
export function toolVerb(name: string, w: Words, args?: Record<string, unknown>, labels: McpLabels = {}): string {
  const proxied = mcpToolName(name);
  if (proxied) {
    const subject = `${labels[proxied.connector] || proxied.connector} · ${proxied.tool}`;
    return w(`Call ${subject}`, `调用 ${subject}`, `呼叫 ${subject}`);
  }
  switch (name) {
    case "bash":
      return w("Run", "运行", "執行");
    case "read":
      return w("Read", "读取", "讀取");
    case "write":
      return w("Write", "写入", "寫入");
    case "edit":
      return w("Edit", "编辑", "編輯");
    case "ls":
      return w("List", "列出", "列出");
    case "find":
    case "grep":
      return w("Search files", "查找文件", "尋找檔案");
    case "web_search":
      return w("Search the web", "搜索网页", "搜尋網頁");
    case "web_fetch":
      return w("Open page", "打开网页", "開啟網頁");
    case "browser":
      return w("Browse", "浏览", "瀏覽");
    case "schedule":
      return w("Schedule", "定时任务", "排程任務");
    case "task":
      return w("Delegate", "分派子任务", "分派子任務");
    case "wait":
      return w("Wait for results", "等待后台结果", "等待背景結果");
    case "skill":
      switch (args?.action) {
        case "install":
          return w("Install skill", "安装技能", "安裝技能");
        case "update":
          return w("Update skill", "更新技能", "更新技能");
        case "remove":
          return w("Remove skill", "删除技能", "刪除技能");
        default:
          return w("View skills", "查看技能", "檢視技能");
      }
    case "artifact":
      return args?.action === "list" ? w("List artifacts", "查看作品", "檢視作品") : w("Publish artifact", "发布作品", "發佈作品");
    case "mcp":
      switch (mcpAction(args)) {
        case "call":
          return w("Call", "调用", "呼叫");
        case "list_resources":
        case "read_resource":
          return w("Read resource", "读取资源", "讀取資源");
        case "add":
          return w("Add connector", "添加连接器", "新增連接器");
        case "import":
          return w("Import config", "导入配置", "匯入設定");
        case "remove":
          return w("Remove connector", "删除连接器", "刪除連接器");
        case "connect":
          return w("Request sign-in", "请求连接", "請求連接");
        case "enable":
          return w("Enable connector", "启用连接器", "啟用連接器");
        case "disable":
          return w("Disable connector", "停用连接器", "停用連接器");
        default:
          return w("View connectors", "查看连接器", "檢視連接器");
      }
    case "job":
      switch (args?.action) {
        case "list":
          return w("List background tasks", "查看后台任务", "檢視背景任務");
        case "status":
          return w("Check task", "查看任务状态", "檢視任務狀態");
        case "output":
          return w("Read task output", "读取任务输出", "讀取任務輸出");
        case "input":
          return w("Send input", "向任务发送输入", "向任務傳送輸入");
        case "stop":
          return w("Stop task", "停止后台任务", "停止背景任務");
        default:
          return w("Manage background task", "管理后台任务", "管理背景任務");
      }
    default:
      return name;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Old records store epoch seconds as strings or numbers. */
function epochTime(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** A `metadata.work` v1 record. A running subagent's work (`GET /api/tasks/{id}`, `live`) may end in a tool that is
 * still running: the producer stores an unfinished tool as `cancelled` with `ended_at: null` until its `tool_end`.
 * In a settled record such a tool was cut short. */
export function parseWork(value: unknown, live = false): WorkTrace | null {
  const work = record(value);
  if (!work || work.v !== 1 || !Array.isArray(work.items)) return null;
  const items: WorkItem[] = [];
  for (const raw of work.items) {
    const item = record(raw);
    if (!item) continue;
    if (item.type === "thinking") {
      items.push({ type: "thinking", text: text(item.text), startedAt: isoTime(item.started_at), endedAt: isoTime(item.ended_at) });
    }
    else if (item.type === "text") items.push({ type: "text", text: text(item.text) });
    else if (item.type === "input" && typeof item.message_id === "number") {
      items.push({ type: "input", messageId: item.message_id, at: isoTime(item.at) });
    }
    else if (item.type === "tool") {
      const status = item.status === "done" || item.status === "error" ? item.status : live && item.ended_at == null ? "running" : "cancelled";
      const background = text(record(item.background)?.task_id);
      items.push({
        type: "tool", id: text(item.id), name: text(item.name), args: record(item.args) ?? {}, status,
        output: text(item.output), startedAt: isoTime(item.started_at), endedAt: isoTime(item.ended_at),
        ...(background ? { background } : {}),
      });
    }
  }
  return { items, startedAt: isoTime(work.started_at), endedAt: isoTime(work.ended_at), truncated: work.truncated === true, omitted: 0 };
}

const OLD_TOOL_STATUS: Record<string, "done" | "error"> = { completed: "done", failed: "error" };

/** Maps `metadata.agent_work.activity[]` from the previous system (read-only; removed actions never return). */
function fromActivity(activity: unknown[]): WorkTrace {
  const items: WorkItem[] = [];
  const times: number[] = [];
  let omitted = 0;
  let truncated = false;
  for (const raw of activity) {
    const entry = record(raw);
    if (!entry) continue;
    const detail = text(entry.detail);
    const at = epochTime(entry.at);
    if (at !== null) times.push(at);
    if (entry.stage === "work.truncated") {
      truncated = true;
      if (typeof entry.omitted_events === "number") omitted += entry.omitted_events;
    } else if (entry.stage === "tool") {
      const parameters = record(entry.parameters);
      const ended = epochTime(entry.completed_at);
      if (ended !== null) times.push(ended);
      items.push({
        type: "tool", id: `old-${items.length}`, name: text(entry.tool) || text(entry.label),
        args: parameters ?? (detail ? { detail } : {}), status: OLD_TOOL_STATUS[text(entry.tool_status)] ?? "cancelled",
        output: text(entry.result), startedAt: at, endedAt: ended,
      });
    } else if (entry.stage === "assistant.message") {
      const body = detail || text(entry.line);
      if (body) items.push({ type: "text", text: body });
    } else {
      const label = text(entry.label);
      if (label || detail) items.push({ type: "step", label, detail });
    }
  }
  return {
    items, truncated, omitted,
    startedAt: times.length ? Math.min(...times) : null,
    endedAt: times.length > 1 ? Math.max(...times) : null,
  };
}

/** The persisted trace of an assistant message: `metadata.work` v1, else the old `agent_work` record. */
export function messageWork(message: Message): WorkTrace | null {
  const work = record(message.metadata.work);
  if (work) {
    const trace = parseWork(work);
    if (trace && trace.items.length) return trace;
  }
  const old = record(message.metadata.agent_work);
  if (old && Array.isArray(old.activity)) {
    const trace = fromActivity(old.activity);
    if (trace.items.length || trace.truncated) return trace;
  }
  return null;
}

/** Text after the last tool or delivered input is the answer; earlier text remains in its work segment. */
export function splitLive(items: WorkItem[]): { work: WorkItem[]; answer: string } {
  let lastBoundary = -1;
  items.forEach((item, index) => {
    if (item.type === "tool" || item.type === "input") lastBoundary = index;
  });
  const work: WorkItem[] = [];
  let answer = "";
  items.forEach((item, index) => {
    if (item.type === "text" && index > lastBoundary) answer += item.text;
    else work.push(item);
  });
  return { work, answer };
}

/** Live and persisted traces use identical segment boundaries and keep the enclosing run's identity. */
export function workSegments(trace: WorkTrace): { key: string; trace: WorkTrace; input: number | null }[] {
  const segments: { key: string; trace: WorkTrace; input: number | null }[] = [];
  let key = "start";
  let startedAt = trace.startedAt;
  let items: WorkItem[] = [];
  for (const item of trace.items) {
    if (item.type !== "input") {
      items.push(item);
      continue;
    }
    segments.push({ key, trace: { items, startedAt, endedAt: item.at, truncated: false, omitted: 0 }, input: item.messageId });
    key = `after-${item.messageId}`;
    startedAt = item.at;
    items = [];
  }
  segments.push({ key, trace: { ...trace, items, startedAt }, input: null });
  return segments;
}
