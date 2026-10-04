import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ThinkingState, { TraceProse, TraceStep, TraceThinking } from "../../components/ui/beautiful/primitives/ThinkingState";
import ToolChips, { type ToolDetailLine, type ToolDiff, type ToolDiffLine, type ToolStep } from "../../components/ui/beautiful/primitives/ToolChips";
import { useWords } from "../../words";
import { ComputerContext, fileName } from "./computerView";
import { Markdown } from "./Markdown";
import { formatThinking } from "./thinking";
import type { RunRef } from "./types";
import { toolVerb, type WorkItem, type WorkTrace, type Words } from "./work";

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

/** How one tool call reads as a ToolChips row (and, for file writes, a diff chip). */
function describe(tool: ToolItem, w: Words): { step: ToolStep; diff?: ToolDiff; diffLines?: ToolDiffLine[] } {
  const { args } = tool;
  const path = arg(args, "path");
  let icon = "tool";
  let label = toolVerb(tool.name, w);
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
    case "web_search":
      icon = "web";
      chip = arg(args, "query");
      mono = false;
      break;
    case "web_fetch":
      icon = "web";
      chip = arg(args, "url");
      break;
    case "browser":
      icon = "web";
      chip = [arg(args, "action"), arg(args, "url") || arg(args, "text") || arg(args, "key")].filter(Boolean).join("  ");
      break;
    case "schedule":
      chip = arg(args, "action") || arg(args, "name");
      input = lines(JSON.stringify(args, null, 2), "muted");
      break;
    default: {
      const json = Object.keys(args).length ? JSON.stringify(args) : "";
      chip = arg(args, "_preview") || arg(args, "detail") || [arg(args, "server"), arg(args, "tool")].filter(Boolean).join(" · ") || json;
      input = json ? lines(JSON.stringify(args, null, 2), "muted") : [];
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

function ToolGroup({ tools, run }: { tools: ToolItem[]; run: RunRef }) {
  const w = useWords();
  const computer = useContext(ComputerContext);
  const described = tools.map((tool) => describe(tool, w));
  const diffs = new Map<string, ToolDiff>();
  const diffLines: Record<string, ToolDiffLine[]> = {};
  for (const { diff, diffLines: rows } of described) {
    if (!diff) continue;
    const previous = diffs.get(diff.file);
    diffs.set(diff.file, previous ? { ...diff, add: previous.add + diff.add, del: previous.del + diff.del } : diff);
    diffLines[diff.file] = [...(diffLines[diff.file] ?? []), ...(rows ?? [])].slice(0, 12);
  }
  const count = tools.length;
  return (
    <ToolChips
      steps={described.map(({ step }) => step)}
      diffs={[...diffs.values()]}
      diffLines={diffLines}
      rowAction={computer ? { label: w("View in computer", "在电脑中查看", "在電腦中檢視"), onSelect: (id) => computer.show(run, id) } : undefined}
      labels={{
        header: w(`${count} tool ${count === 1 ? "call" : "calls"}`, `${count} 次工具调用`, `${count} 次工具呼叫`),
        showDiff: (file) => w(`Show changes to ${file}`, `查看 ${file} 的改动`, `查看 ${file} 的變更`),
      }}
    />
  );
}

function seconds(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Re-renders every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Each mounted block keeps its own formatting memo; settled Markdown never reparses on clock ticks. */
const ThinkingBlock = memo(function ThinkingBlock({ item, streaming, end }: {
  item: ThinkingItem;
  streaming: boolean;
  end: number | null;
}) {
  const w = useWords();
  const content = useMemo(() => formatThinking(item.text), [item.text]);
  if (!content) return streaming ? <TraceThinking label={w("Thinking", "思考中", "思考中")} /> : null;
  const elapsed = item.startedAt !== null && end !== null ? Math.max(0, Math.round((end - item.startedAt) / 1000)) : null;
  const duration = elapsed === null ? null : seconds(elapsed * 1000);
  const heading = streaming
    ? w(`Thinking · ${duration}`, `思考中 · ${duration}`, `思考中 · ${duration}`)
    : duration === null ? w("Thought", "思考", "思考")
      : w(`Thought for ${duration}`, `思考了 ${duration}`, `思考了 ${duration}`);
  return <TraceProse heading={heading}><Markdown content={content} /></TraceProse>;
});

function activeLabel(items: WorkItem[], w: Words): string {
  const last = items[items.length - 1];
  if (last?.type === "tool" && last.status === "running") {
    if (last.name === "web_search" || last.name === "web_fetch") return w("Searching the web", "正在搜索网页", "正在搜尋網頁");
    return w("Running tools", "正在使用工具", "正在使用工具");
  }
  return w("Thinking", "思考中", "思考中");
}

/** An assistant turn's work: ThinkingState around reasoning, interim text, old status steps and ToolChips groups.
 * `run` identifies the turn for the personal AI computer panel ("View in computer"). */
export function WorkView({ trace, working, run }: { trace: WorkTrace; working: boolean; run: RunRef }) {
  const w = useWords();
  const now = useNow(working);
  // A live trace settles when its answer starts; freeze the clock at that moment.
  const settledAt = useRef<number | null>(null);
  if (working) settledAt.current = null;
  else settledAt.current ??= trace.endedAt ?? now;
  const end = working ? now : trace.endedAt ?? settledAt.current;
  const duration = trace.startedAt !== null && end !== null ? seconds(end - trace.startedAt) : null;
  const thought = trace.items.some((item) => item.type === "thinking");
  const done = duration === null ? w("Recorded work", "工作记录", "工作紀錄")
    : thought ? w(`Thought for ${duration}`, `已思考 ${duration}`, `已思考 ${duration}`)
      : w(`Worked for ${duration}`, `已处理 ${duration}`, `已處理 ${duration}`);

  const blocks: ReactNode[] = [];
  let group: ToolItem[] = [];
  const flush = () => {
    if (group.length) blocks.push(<ToolGroup key={`tools-${group[0].id}-${blocks.length}`} tools={group} run={run} />);
    group = [];
  };
  trace.items.forEach((item, index) => {
    if (item.type === "tool") {
      group.push(item);
      return;
    }
    flush();
    if (item.type === "thinking") {
      const streaming = working && item.startedAt !== null && item.endedAt === null;
      blocks.push(<ThinkingBlock key={index} item={item} streaming={streaming} end={item.endedAt ?? (streaming ? now : null)} />);
    }
    else if (item.type === "text") blocks.push(
      <div key={index} className="bui-prose px-1.5 py-0.5 text-[12.5px] leading-relaxed text-ink"><Markdown content={item.text} /></div>,
    );
    else if (item.type === "step") blocks.push(<TraceStep key={index} primary={item.label || item.detail} secondary={item.label ? item.detail : undefined} />);
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
      active={<>{activeLabel(trace.items, w)} <span aria-hidden className="tabular-nums">{duration}</span></>}
      done={done}
    >
      {blocks}
    </ThinkingState>
  );
}
