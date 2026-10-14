import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ThinkingState, { TraceProse, TraceStep, TraceThinking } from "../../components/ui/beautiful/primitives/ThinkingState";
import ToolChips, { type ToolChildRow, type ToolDetailLine, type ToolDiff, type ToolDiffLine, type ToolStep } from "../../components/ui/beautiful/primitives/ToolChips";
import { useWords } from "../../words";
import { ComputerContext, fileName, parsePatch } from "./computerView";
import { Markdown } from "./Markdown";
import { SiteMark, SiteStack } from "./SiteMark";
import { TASK_TOOL_STATE, TasksContext, agentTypeLabel, isRunning, promotedTaskId, taskElapsed, taskStatusLabel, tokenCount, type TasksValue, type TaskView } from "./taskState";
import { formatThinking } from "./thinking";
import type { RunRef } from "./types";
import { WEB_TOOLS, calmFailure, clipQuery, engineList, failureDetail, failureShort, safeHref, siteOf } from "./web";
import { McpLabelsContext, mcpSubject, mcpToolName, toolVerb, type McpLabels, type WorkItem, type WorkTrace, type Words } from "./work";

type ToolItem = Extract<WorkItem, { type: "tool" }>;
type ThinkingItem = Extract<WorkItem, { type: "thinking" }>;

const DETAIL_LIMIT = 4000;

function arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function lines(text: string, tone?: ToolDetailLine["tone"]): ToolDetailLine[] {
  const clipped = text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
  return clipped ? clipped.split("\n").map((line) => ({ text: line || " ", tone })) : [];
}

function lineCount(text: string): number {
  return text ? text.replace(/\n$/, "").split("\n").length : 0;
}

/** Edit tools send `edits: [{oldText,newText}]` or a single `oldText`/`newText` pair. */
function editPairs(args: Record<string, unknown>): { oldText: string; newText: string }[] {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  return edits.flatMap((edit: unknown) => {
    if (!edit || typeof edit !== "object") return [];
    const record = edit as Record<string, unknown>;
    return typeof record.oldText === "string" || typeof record.newText === "string"
      ? [{ oldText: String(record.oldText ?? ""), newText: String(record.newText ?? "") }]
      : [];
  });
}

/** A tool call as one ToolChips row, plus the diff chip a file write contributes. */
type Described = { step: ToolStep; diff?: ToolDiff; diffLines?: ToolDiffLine[] };

/** A web step as a ToolChips row: the query or the site (its monogram leading the chip) while it runs, then what it
 * found — stacked result sites and a count, or the page's title — or, calmly, why a page could not be read. The
 * expanded detail lists result links, the start of the page, or the full explanation. */
function describeWeb(tool: ToolItem, w: Words): ToolStep {
  const { web } = tool;
  const running = tool.status === "running";
  const failure = web?.kind === "failure" ? web : null;
  const calm = calmFailure(web);
  const base = {
    id: tool.id, mono: false, detailMono: false, state: tool.status === "done" ? "done" as const : tool.status, shimmer: true,
    stateLabel: tool.status === "cancelled" ? w("Stopped", "已停止", "已停止") : tool.status === "error" && !calm ? w("Failed", "失败", "失敗") : undefined,
  };
  if (tool.name === "web_search") {
    const search = web?.kind === "search" ? web : null;
    const count = search?.results.length ?? 0;
    const detail: ToolDetailLine[] = (search?.results ?? []).map((result) => ({ text: result.title || siteOf(result.url), href: safeHref(result.url), meta: siteOf(result.url) }));
    if (search?.unresponsive.length) {
      detail.push({ text: w(`Unavailable engines: ${engineList(search.unresponsive, w)}`, `暂不可用的搜索引擎：${engineList(search.unresponsive, w)}`, `暫不可用的搜尋引擎：${engineList(search.unresponsive, w)}`), tone: "muted" });
    }
    if (search?.text) detail.push(...lines(search.text));
    if (failure?.message) detail.push(...lines(failure.message, "muted"));
    return {
      ...base, icon: "search", loader: "Orbit", label: running ? w("Searching", "正在搜索", "正在搜尋") : w("Searched", "搜索", "搜尋"),
      chip: arg(tool.args, "query") || search?.query || "", detail,
      ...(failure ? { stateLabel: w("Search unavailable", "搜索暂不可用", "搜尋暫不可用") } : {}),
      ...(search && !search.text ? {
        trail: count
          ? <><SiteStack urls={search.results.map((result) => result.url)} /><span>{w(`${count} ${count === 1 ? "result" : "results"}`, `${count} 条结果`, `${count} 筆結果`)}</span></>
          : <span>{w("No results", "没有结果", "沒有結果")}</span>,
      } : {}),
    };
  }
  const page = web?.kind === "page" ? web : null;
  const url = page?.url || arg(tool.args, "url");
  const site = siteOf(url);
  const detail: ToolDetailLine[] = [];
  if (page) {
    detail.push({ text: page.title || site, href: safeHref(page.url), meta: page.via === "browser" ? w("opened in a browser", "经浏览器打开", "經瀏覽器開啟") : site });
    const excerpt = page.excerpt.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).filter(Boolean).slice(0, 4);
    detail.push(...excerpt.map((text) => ({ text, tone: "muted" as const })));
  }
  if (failure) {
    detail.push(...failureDetail(failure, w).map((text) => ({ text })));
    if (safeHref(url)) detail.push({ text: w("Open the original page", "打开原网页", "開啟原網頁"), href: url, meta: site });
  }
  return {
    ...base, icon: "web", loader: "Drive", label: running ? w("Reading", "正在阅读", "正在閱讀") : w("Read", "阅读", "閱讀"),
    chip: page?.title ? `${site} · ${page.title}` : site, lead: site ? <SiteMark url={url} className="size-4 text-[8.5px]" /> : undefined, detail,
    ...(calm ? { calm: true, stateLabel: failureShort(calm, w) } : {}),
  };
}

/** How one tool call reads as a ToolChips row (and, for file writes, a diff chip). */
function describe(tool: ToolItem, w: Words, labels: McpLabels): Described {
  if (WEB_TOOLS[tool.name]) return { step: describeWeb(tool, w) };
  const { args } = tool;
  const path = arg(args, "path");
  let icon = "tool";
  let label = toolVerb(tool.name, w, args, labels);
  let chip = "";
  let mono = true;
  let input: ToolDetailLine[] = [];
  let diff: ToolDiff | undefined;
  let diffLines: ToolDiffLine[] | undefined;
  switch (tool.name) {
    case "bash":
      icon = "run";
      chip = arg(args, "command");
      input = lines(`$ ${chip}`, "muted");
      break;
    case "read":
      icon = "read";
      chip = path;
      break;
    case "write": {
      const content = arg(args, "content");
      icon = "write";
      label = w(`Write ${lineCount(content)} lines`, `写入 ${lineCount(content)} 行`, `寫入 ${lineCount(content)} 行`);
      chip = path;
      input = lines(content, "add");
      if (path) {
        diff = { file: fileName(path), add: lineCount(content), del: 0 };
        diffLines = content.split("\n").slice(0, 8).map((text) => ({ text, tone: "add" }));
      }
      break;
    }
    case "edit": {
      const pairs = editPairs(args);
      const add = pairs.reduce((sum, pair) => sum + lineCount(pair.newText), 0);
      const del = pairs.reduce((sum, pair) => sum + lineCount(pair.oldText), 0);
      icon = "write";
      chip = path;
      input = pairs.flatMap((pair) => [...lines(pair.oldText, "del"), ...lines(pair.newText, "add")]);
      if (path && pairs.length) {
        diff = { file: fileName(path), add, del };
        diffLines = pairs.flatMap((pair) => [
          ...pair.oldText.split("\n").map((text) => ({ text, tone: "del" as const })),
          ...pair.newText.split("\n").map((text) => ({ text, tone: "add" as const })),
        ]).slice(0, 10);
      }
      break;
    }
    case "ls":
    case "find":
    case "grep":
      icon = "search";
      chip = [arg(args, "pattern"), path].filter(Boolean).join("  ") || ".";
      break;
    case "browser":
      icon = "web";
      chip = [arg(args, "action"), arg(args, "url") || arg(args, "text") || arg(args, "key")].filter(Boolean).join("  ");
      break;
    case "schedule":
      chip = arg(args, "action") || arg(args, "name");
      input = lines(JSON.stringify(args, null, 2), "muted");
      break;
    case "task": {
      const assignments: unknown[] = Array.isArray(args.tasks) ? args.tasks : [];
      icon = "agents";
      chip = assignments.map((entry) => {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        return arg(item, "name") || arg(item, "task").split("\n", 1)[0].slice(0, 60);
      }).filter(Boolean).join(" · ");
      mono = false;
      input = lines(JSON.stringify(args, null, 2), "muted");
      break;
    }
    case "job":
      icon = "run";
      chip = [arg(args, "id"), arg(args, "action") === "input" ? arg(args, "text") : ""].filter(Boolean).join("  ");
      input = lines(JSON.stringify(args, null, 2), "muted");
      break;
    case "wait":
      icon = "clock";
      chip = Array.isArray(args.ids) && args.ids.length ? args.ids.filter((id): id is string => typeof id === "string").join(" ") : w("Any task", "任一任务", "任一任務");
      break;
    case "skill": {
      // install names its source (a link, a workspace path or new content); the others name the skill.
      const content = args.content && typeof args.content === "object" ? args.content as Record<string, unknown> : {};
      chip = arg(args, "name") || arg(args, "url") || arg(args, "path") || arg(content, "name");
      input = lines(JSON.stringify(args, null, 2), "muted");
      break;
    }
    case "artifact":
      // publish names the artifact (its title, else its sandbox path); list has no subject.
      icon = "write";
      chip = arg(args, "title") || path;
      break;
    case "mcp":
      // the call's arguments are the connector tool's own; the subject names connector and tool, a URI or a file
      chip = mcpSubject(args, labels);
      mono = arg(args, "action") === "read_resource" || arg(args, "action") === "import";
      input = lines(JSON.stringify(args, null, 2), "muted");
      break;
    default: {
      const json = Object.keys(args).length ? JSON.stringify(args) : "";
      // a connector's tool already names connector and tool in its verb; its arguments are the detail
      chip = mcpToolName(tool.name) ? "" : arg(args, "_preview") || arg(args, "detail") || json;
      input = json ? lines(JSON.stringify(args, null, 2), "muted") : [];
    }
  }
  // A finished edit or write with its whole patch counts exactly (an overwrite's removed lines too).
  if (diff && tool.patch && !tool.patchCut) {
    const patch = parsePatch(tool.patch);
    if (!patch.cut) {
      diff = { ...diff, add: patch.added, del: patch.removed };
      diffLines = patch.rows.flatMap((row) => (row.type === "add" || row.type === "del" ? [{ text: row.text, tone: row.type }] : [])).slice(0, 10);
    }
  }
  // Oversized arguments arrive as a JSON preview only.
  if (arg(args, "_preview")) input = lines(arg(args, "_preview"), "muted");
  const output = lines(tool.output, tool.status === "error" ? "error" : undefined);
  const stateLabel = tool.status === "running" ? w("Running", "进行中", "進行中")
    : tool.status === "error" ? w("Failed", "失败", "失敗")
      : tool.status === "cancelled" ? w("Stopped", "已停止", "已停止") : undefined;
  return {
    step: {
      id: tool.id, icon, label, chip, mono, detailMono: true, state: tool.status === "done" ? "done" : tool.status, stateLabel,
      detail: [...input, ...(input.length && output.length ? [{ text: " " }] : []), ...output],
    },
    diff,
    diffLines,
  };
}

/** A subagent's id, elapsed time and tokens; it ticks on its own while the subagent runs, even after the turn ended. */
function SubagentMeta({ task }: { task: TaskView }) {
  const w = useWords();
  const now = useNow(isRunning(task));
  return [task.id, taskElapsed(task, now), task.usage ? tokenCount(task.usage.total_tokens, w) : null].filter(Boolean).join(" · ");
}

/** A subagent under the `task` row that started it: name, type chip, activity, then id, elapsed time and tokens. */
function subagentRow(task: TaskView, tasks: TasksValue, w: Words, labels: McpLabels): ToolChildRow {
  const activity = isRunning(task)
    ? task.current ? `${toolVerb(task.current.tool, w, undefined, labels)} ${task.current.summary}`.trim() : w("Thinking", "思考中", "思考中")
    : task.status === "completed" && task.result_preview ? task.result_preview.split("\n").find((line) => line.trim()) ?? taskStatusLabel(task, w)
      : taskStatusLabel(task, w);
  return {
    id: task.id, label: task.name || task.id, tag: agentTypeLabel(task.agent_type, w), state: TASK_TOOL_STATE[task.status],
    stateLabel: taskStatusLabel(task, w), activity, meta: <SubagentMeta task={task} />, onSelect: () => tasks.open(task.id),
  };
}

/** One run of consecutive tool calls. It re-renders only when one of its calls changed (the live reducer keeps
 * unchanged items by identity), and describes each call once per item. */
const ToolGroup = memo(function ToolGroup({ tools, run }: { tools: ToolItem[]; run: RunRef }) {
  const w = useWords();
  const computer = useContext(ComputerContext);
  const tasks = useContext(TasksContext);
  const labels = useContext(McpLabelsContext);
  const cache = useMemo(() => new WeakMap<ToolItem, Described>(), [w, labels]);
  const described = useMemo(() => tools.map((tool) => {
    let entry = cache.get(tool);
    if (!entry) cache.set(tool, entry = describe(tool, w, labels));
    return entry;
  }), [cache, tools, w, labels]);
  const { diffs, diffLines } = useMemo(() => {
    const files = new Map<string, ToolDiff>();
    const lines: Record<string, ToolDiffLine[]> = {};
    for (const { diff, diffLines: rows } of described) {
      if (!diff) continue;
      const previous = files.get(diff.file);
      files.set(diff.file, previous ? { ...diff, add: previous.add + diff.add, del: previous.del + diff.del } : diff);
      lines[diff.file] = [...(lines[diff.file] ?? []), ...(rows ?? [])].slice(0, 12);
    }
    return { diffs: [...files.values()], diffLines: lines };
  }, [described]);
  const agents = tasks ? tools.flatMap((tool) => tool.name === "task" ? (tasks.byToolCall.get(tool.id) ?? []).filter((task) => task.kind === "agent") : []) : [];
  const steps = described.map(({ step }, index) => {
    const tool = tools[index];
    if (tool.name === "task" && tasks) {
      return { ...step, children: agents.filter((task) => task.created_by_tool_call_id === tool.id).map((task) => subagentRow(task, tasks, w, labels)) };
    }
    const background = tool.name === "bash" ? tool.background ?? promotedTaskId(tool.output) : null;
    if (!background) return step;
    const task = tasks?.byId.get(background);
    return {
      ...step,
      badge: {
        label: w(`Background · ${background}`, `后台 · ${background}`, `背景 · ${background}`),
        state: task ? TASK_TOOL_STATE[task.status] : "running",
        stateLabel: task ? taskStatusLabel(task, w) : w("Running", "运行中", "執行中"),
        onSelect: tasks ? () => tasks.open(background) : undefined,
      },
    };
  });
  const count = tools.length;
  const header = WEB_TOOLS[tools[0].name] ? webHeader(tools, w) : w(`${count} tool ${count === 1 ? "call" : "calls"}`, `${count} 次工具调用`, `${count} 次工具呼叫`);
  return (
    <ToolChips
      steps={steps}
      diffs={diffs}
      diffLines={diffLines}
      rowAction={computer ? { label: w("View in computer", "在电脑中查看", "在電腦中檢視"), onSelect: (id) => computer.show(run, id) } : undefined}
      labels={{
        header,
        showDiff: (file) => w(`Show changes to ${file}`, `查看 ${file} 的改动`, `查看 ${file} 的變更`),
      }}
    />
  );
}, (previous, next) => previous.run === next.run && previous.tools.length === next.tools.length
  && previous.tools.every((tool, index) => tool === next.tools[index]));

function seconds(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Re-renders every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** A running duration as text. The clock lives in this leaf, so its tick re-renders only the text, never the trace. */
function Elapsed({ since, format }: { since: number; format?: (duration: string) => string }) {
  const duration = seconds(useNow(true) - since);
  return format ? format(duration) : duration;
}

/** Each mounted block keeps its own formatting memo; settled Markdown never reparses on stream or clock ticks. */
const ThinkingBlock = memo(function ThinkingBlock({ item, streaming }: { item: ThinkingItem; streaming: boolean }) {
  const w = useWords();
  const content = useMemo(() => formatThinking(item.text), [item.text]);
  if (!content) return streaming ? <TraceThinking label={w("Thinking", "思考中", "思考中")} /> : null;
  const { startedAt, endedAt } = item;
  const heading = streaming && startedAt !== null
    ? <Elapsed since={startedAt} format={(duration) => w(`Thinking · ${duration}`, `思考中 · ${duration}`, `思考中 · ${duration}`)} />
    : startedAt === null || endedAt === null ? w("Thought", "思考", "思考")
      : w(`Thought for ${seconds(endedAt - startedAt)}`, `思考了 ${seconds(endedAt - startedAt)}`, `思考了 ${seconds(endedAt - startedAt)}`);
  return <TraceProse heading={heading}><Markdown content={content} /></TraceProse>;
});

/** A run of web steps in one phrase: "搜索 2 次 · 阅读 3 个网页 · 1 个无法打开". */
function webHeader(tools: ToolItem[], w: Words): string {
  const searches = tools.filter((tool) => tool.name === "web_search").length;
  // Only finished steps count: a page is read once its text came back, and could not be opened once it failed.
  const failed = tools.filter((tool) => tool.name === "web_fetch" && tool.web?.kind === "failure").length;
  const reads = tools.filter((tool) => tool.name === "web_fetch" && tool.web?.kind === "page").length;
  const opening = tools.filter((tool) => tool.name === "web_fetch" && tool.status === "running").length;
  const phrase = [
    searches ? w(`${searches} ${searches === 1 ? "search" : "searches"}`, `搜索 ${searches} 次`, `搜尋 ${searches} 次`) : "",
    reads ? w(`${reads} ${reads === 1 ? "page" : "pages"} read`, `阅读 ${reads} 个网页`, `閱讀 ${reads} 個網頁`) : "",
    failed ? w(`${failed} could not be opened`, `${failed} 个无法打开`, `${failed} 個無法開啟`) : "",
    opening ? w(`opening ${opening} ${opening === 1 ? "page" : "pages"}`, `正在打开 ${opening} 个网页`, `正在開啟 ${opening} 個網頁`) : "",
  ].filter(Boolean).join(" · ");
  // Only stopped page reads: say how many web steps there were. English starts with a capital ("Opening 1 page").
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1)
    : w(`${tools.length} web ${tools.length === 1 ? "step" : "steps"}`, `${tools.length} 个网页步骤`, `${tools.length} 個網頁步驟`);
}

function activeLabel(items: WorkItem[], w: Words): string {
  const last = items[items.length - 1];
  if (last?.type === "tool" && last.status === "running") {
    if (last.name === "web_search") {
      const query = clipQuery(arg(last.args, "query"));
      return query ? w(`Searching for “${query}”`, `正在搜索「${query}」`, `正在搜尋「${query}」`) : w("Searching the web", "正在搜索网页", "正在搜尋網頁");
    }
    if (last.name === "web_fetch") {
      const site = siteOf(arg(last.args, "url"));
      return site ? w(`Reading ${site}`, `正在阅读 ${site}`, `正在閱讀 ${site}`) : w("Reading a page", "正在阅读网页", "正在閱讀網頁");
    }
    if (last.name === "wait") return w("Waiting for background results", "正在等待后台结果", "正在等待背景結果");
    return w("Running tools", "正在使用工具", "正在使用工具");
  }
  return w("Thinking", "思考中", "思考中");
}

/** An assistant turn's work: ThinkingState around reasoning, interim text, old status steps and ToolChips groups.
 * `run` identifies the turn for the personal AI computer panel ("View in computer"). Clocks tick in leaf components;
 * blocks are keyed by their first item, which the append-only trace keeps in place. */
export function WorkView({ trace, working, run }: { trace: WorkTrace; working: boolean; run: RunRef }) {
  const w = useWords();
  // A live trace settles when its answer starts; freeze the clock at that moment.
  const settledAt = useRef<number | null>(null);
  if (working) settledAt.current = null;
  else settledAt.current ??= trace.endedAt ?? Date.now();
  const end = trace.endedAt ?? settledAt.current;
  const duration = trace.startedAt !== null && end !== null ? seconds(end - trace.startedAt) : null;
  const thought = trace.items.some((item) => item.type === "thinking");
  const done = duration === null ? w("Recorded work", "工作记录", "工作紀錄")
    : thought ? w(`Thought for ${duration}`, `已思考 ${duration}`, `已思考 ${duration}`)
      : w(`Worked for ${duration}`, `已处理 ${duration}`, `已處理 ${duration}`);

  const blocks: ReactNode[] = [];
  let group: ToolItem[] = [];
  const flush = () => {
    if (group.length) blocks.push(<ToolGroup key={`tools-${group[0].id}`} tools={group} run={run} />);
    group = [];
  };
  trace.items.forEach((item, index) => {
    if (item.type === "tool") {
      // Consecutive web steps form their own group, read as one search session.
      if (group.length && Boolean(WEB_TOOLS[group[0].name]) !== Boolean(WEB_TOOLS[item.name])) flush();
      group.push(item);
      return;
    }
    flush();
    if (item.type === "thinking") {
      blocks.push(<ThinkingBlock key={`thinking-${index}`} item={item} streaming={working && item.startedAt !== null && item.endedAt === null} />);
    }
    else if (item.type === "text") blocks.push(
      <div key={`text-${index}`} className="bui-prose px-1.5 py-0.5 text-[12.5px] leading-relaxed text-ink"><Markdown content={item.text} /></div>,
    );
    else if (item.type === "step") blocks.push(<TraceStep key={`step-${index}`} primary={item.label || item.detail} secondary={item.label ? item.detail : undefined} />);
  });
  flush();
  if (trace.truncated) {
    blocks.push(
      <p key="truncated" className="px-1.5 text-[12px] text-ink-2">
        {trace.omitted
          ? w(`Earlier activity was omitted (${trace.omitted})`, `部分早期活动已省略（${trace.omitted}）`, `部分早期活動已省略（${trace.omitted}）`)
          : w("Part of this work was too long to keep", "部分工作内容过长，未完整保留", "部分工作內容過長，未完整保留")}
      </p>,
    );
  }

  return (
    <ThinkingState
      working={working}
      active={<>{activeLabel(trace.items, w)} <span aria-hidden className="tabular-nums">{trace.startedAt !== null && <Elapsed since={trace.startedAt} />}</span></>}
      done={done}
    >
      {blocks}
    </ThinkingState>
  );
}
