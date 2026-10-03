import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { parseUnifiedDiff, type DiffRow } from "../../components/ui/beautiful/primitives/CodeBlock";
import { useWords } from "../../words";
import { commandLine, fileName, headLines, host, stepKind, str, tailLines } from "./computerView";
import type { ToolCall } from "./types";
import { toolVerb, type Words } from "./work";

/* What the computer window shows for one step, by kind: a terminal transcript, a file, search results, a fetched
 * page, a page card for an older browser step, or any other tool's arguments and result. Every view is a scrolling
 * frame that follows the end while the step streams (until the reader scrolls up) and reuses CodeBlock's look
 * (mono 12.5px, 1.65 leading, a hairline gutter, green/red row tints). Only part of long text is rendered. */

/** Same stick rule as the conversation: following the end until the reader scrolls up past this distance. */
const STICK_PX = 120;

/** Rendering limits: the window and the larger expanded viewer. */
const LIMITS = {
  window: { entries: 20, lastLines: 200, lines: 12, rows: 300, reader: 300 },
  viewer: { entries: 40, lastLines: 400, lines: 40, rows: 600, reader: 600 },
} as const;
type Limits = (typeof LIMITS)[keyof typeof LIMITS];

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";
const MONO = "font-mono text-[12.5px] leading-[1.65]";
const NOTE = "text-[12px] text-ink-2";

function running(call: ToolCall): boolean {
  return call.status === "preparing" || call.status === "running";
}

/** Thin ring while running, a check when done, a warning mark on failure (the site's single state expression). */
function StateMark({ status, label }: { status: ToolCall["status"]; label: string }) {
  if (status === "preparing" || status === "running") {
    return (
      <svg role="img" aria-label={label} width={14} height={14} viewBox="0 0 14 14" className="shrink-0" style={{ animation: "spin 1.1s linear infinite" }}>
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.8" />
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="9.7 24.8" />
      </svg>
    );
  }
  const failed = status === "error";
  return (
    <svg role="img" aria-label={label} width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${failed ? "text-red-ink" : status === "done" ? "text-green-ink" : "text-ink-2"}`}>
      {failed ? <><path d="M12 8v5" /><path d="M12 17h.01" /></> : status === "done" ? <path d="M20 6 9 17l-5-5" /> : <path d="M6 12h12" />}
    </svg>
  );
}

export function stateLabel(status: ToolCall["status"], w: Words): string {
  if (status === "preparing") return w("Preparing", "准备中", "準備中");
  if (status === "running") return w("Running", "进行中", "進行中");
  if (status === "error") return w("Failed", "失败", "失敗");
  if (status === "cancelled") return w("Stopped", "已停止", "已停止");
  return w("Done", "已完成", "已完成");
}

/** Reloaded steps keep bounded arguments; oversized ones survive only as a prefix. */
function Clipped({ call, className = "" }: { call: ToolCall; className?: string }) {
  const w = useWords();
  if (typeof call.args._preview !== "string") return null;
  return <p className={`${NOTE} ${className}`}>{w("Only part of this step was kept", "仅保留了部分内容", "僅保留了部分內容")}</p>;
}

/** The window's scrolling frame: follows the end while `stick` holds; a reader scrolling up stops it. */
function FollowEnd({ signal, follow, role, label, children }: { signal: unknown; follow: boolean; role?: "log"; label: string; children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null);
  const stick = useRef(follow);
  useLayoutEffect(() => {
    const el = node.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [signal]);
  return (
    <div
      ref={node}
      role={role}
      aria-label={label}
      // A log announces appended text by default; the panel announces state changes itself.
      aria-live={role === "log" ? "off" : undefined}
      tabIndex={0}
      className="absolute inset-0 overflow-y-auto overscroll-contain bg-surface"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
    >
      {children}
    </div>
  );
}

const TerminalEntry = memo(function TerminalEntry({ call, max }: { call: ToolCall; max: number }) {
  const w = useWords();
  const tail = useMemo(() => tailLines(call.output, max), [call.output, max]);
  const failed = call.status === "error";
  return (
    <div className={`${MONO} px-3 py-1.5`}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-ink">{commandLine(call)}</span>
        <span className={`mt-[0.35em] ${failed ? "text-red-ink" : "text-ink-2"}`}>
          <StateMark status={call.status} label={stateLabel(call.status, w)} />
        </span>
      </div>
      <Clipped call={call} className="mt-0.5" />
      {tail.lines.length > 0 && (
        <>
          {tail.cut && <p className={`mt-0.5 ${NOTE}`}>{w(`… earlier output omitted (last ${tail.lines.length} lines shown)`, `… 较早的输出已省略（显示最后 ${tail.lines.length} 行）`, `… 較早的輸出已省略（顯示最後 ${tail.lines.length} 行）`)}</p>}
          <div className="whitespace-pre-wrap break-words text-ink-2">{tail.lines.join("\n")}</div>
        </>
      )}
      {failed && <p className={`mt-0.5 ${NOTE} font-medium text-red-ink`}>{stateLabel(call.status, w)}</p>}
      {call.truncated && <p className={`mt-0.5 ${NOTE}`}>{w("Live output limit reached; the final output follows when the command ends.", "实时输出已达上限，命令结束后会显示完整输出。", "即時輸出已達上限，命令結束後會顯示完整輸出。")}</p>}
    </div>
  );
});

/** Every shell step of the run up to and including the shown one, as one read-only transcript. */
function Terminal({ calls, index, limits }: { calls: readonly ToolCall[]; index: number; limits: Limits }) {
  const w = useWords();
  const shell = useMemo(() => calls.slice(0, index + 1).filter((call) => stepKind(call.name) === "shell"), [calls, index]);
  const shown = shell.slice(-limits.entries);
  return (
    <FollowEnd role="log" label={w("Terminal output", "终端输出", "終端輸出")} signal={shown} follow>
      <div className="py-2">
        {shell.length > shown.length && <p className={`px-3 pb-1 ${NOTE}`}>{w(`Showing the last ${shown.length} commands`, `仅显示最近 ${shown.length} 条命令`, `僅顯示最近 ${shown.length} 條命令`)}</p>}
        {shown.map((call, at) => <TerminalEntry key={call.id} call={call} max={at === shown.length - 1 ? limits.lastLines : limits.lines} />)}
      </div>
    </FollowEnd>
  );
}

type Rows = { rows: DiffRow[]; cut: boolean };

/** The listing a file step shows: written/read content as numbered lines, edits as removed and added blocks. */
function fileRows(call: ToolCall, max: number): Rows {
  if (call.name === "edit") {
    if (call.status === "done" && call.diff) {
      const rows = parseUnifiedDiff(call.diff).rows;
      return { rows: rows.slice(-max), cut: rows.length > max };
    }
    // Edits arrive as `edits: [{oldText,newText}]` or a single pair.
    const edits: unknown[] = Array.isArray(call.args.edits) ? call.args.edits : [call.args];
    const rows: DiffRow[] = [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const { oldText, newText } = edit as Record<string, unknown>;
      if (str(oldText)) for (const text of str(oldText).split("\n")) rows.push({ num: null, type: "del", text });
      if (str(newText)) for (const text of str(newText).split("\n")) rows.push({ num: null, type: "add", text });
    }
    return { rows: rows.slice(-max), cut: rows.length > max };
  }
  const tail = tailLines(call.name === "read" ? call.output : str(call.args.content), max);
  return { rows: tail.lines.map((line, at) => ({ num: tail.first + at, type: "ctx" as const, text: line })), cut: tail.cut };
}

function Listing({ rows }: { rows: DiffRow[] }) {
  const digits = String(Math.max(0, ...rows.map((row) => row.num ?? 0))).length;
  const gutter = Math.max(20, digits * 7 + 6);
  return (
    <div className={`relative ${MONO} text-ink-2`}>
      <span className="pointer-events-none absolute inset-y-0 w-px bg-line" style={{ left: gutter }} />
      {rows.map((row, at) => {
        const add = row.type === "add";
        const del = row.type === "del";
        return (
          <div key={at} className={`relative grid items-start ${add ? "bg-green-tint" : del ? "bg-red-tint" : ""}`} style={{ gridTemplateColumns: `${gutter}px minmax(0,1fr)` }}>
            {(add || del) && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: add ? "var(--green)" : HATCH }} />}
            <span className={`select-none text-center text-[11px] ${add ? "text-green-ink" : del ? "text-red-ink" : "text-ink-2"}`}>{row.num ?? (add ? "+" : del ? "−" : "")}</span>
            <code className="break-words whitespace-pre-wrap pl-1 pr-3">{row.text || "\u200b"}</code>
          </div>
        );
      })}
    </div>
  );
}

function FileView({ call, limits }: { call: ToolCall; limits: Limits }) {
  const w = useWords();
  const view = useMemo(() => fileRows(call, limits.rows), [call, limits.rows]);
  const path = str(call.args.path);
  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={path}>{path || "…"}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-ink-2">
          <StateMark status={call.status} label={stateLabel(call.status, w)} />
          {stateLabel(call.status, w)}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <FollowEnd label={path ? `${w("File", "文件", "檔案")}: ${path}` : w("File", "文件", "檔案")} signal={call} follow={running(call)}>
          <div className="py-2">
            <Clipped call={call} className="px-3 pb-1" />
            {view.cut && <p className={`px-3 pb-1 ${NOTE}`}>{w(`Showing the last ${view.rows.length} lines`, `仅显示最后 ${view.rows.length} 行`, `僅顯示最後 ${view.rows.length} 行`)}</p>}
            {view.rows.length ? <Listing rows={view.rows} />
              : <p className={`px-3 ${NOTE}`}>{running(call) ? w("Waiting for content…", "等待内容…", "等待內容…") : w("No content", "没有内容", "沒有內容")}</p>}
            {call.status === "error" && call.output && <p className={`px-3 pt-2 ${MONO} text-red-ink`}>{call.output}</p>}
          </div>
        </FollowEnd>
      </div>
    </div>
  );
}

/** http(s) URLs in plain text as links that open a new tab. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、）】」』]+/g;

function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
    const start = match.index;
    parts.push(text.slice(last, start));
    parts.push(
      <a key={start} href={url} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline decoration-accent-ink/40 underline-offset-2 hover:decoration-accent-ink">
        {url}
      </a>,
    );
    last = start + url.length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** Search results and fetched pages as readable text, links live. */
function ReaderView({ call, limits }: { call: ToolCall; limits: Limits }) {
  const w = useWords();
  const head = useMemo(() => headLines(call.output, limits.reader), [call.output, limits.reader]);
  const body = useMemo(() => linkify(head.text), [head.text]);
  const search = call.name === "web_search";
  const failed = call.status === "error";
  return (
    <FollowEnd label={search ? w("Search results", "搜索结果", "搜尋結果") : w("Page text", "网页内容", "網頁內容")} signal={call} follow={running(call)}>
      <div className="flex flex-col gap-2 px-4 py-3">
        <Clipped call={call} />
        {failed && <p className={`${NOTE} font-medium text-red-ink`}>{stateLabel(call.status, w)}</p>}
        {call.output ? (
          <div className={`whitespace-pre-wrap text-[13px] leading-[1.7] [overflow-wrap:anywhere] ${failed ? "text-ink-2" : "text-ink"}`}>{body}</div>
        ) : (
          <p className={NOTE}>{running(call) ? (search ? w("Searching…", "正在搜索…", "正在搜尋…") : w("Opening the page…", "正在打开网页…", "正在開啟網頁…")) : w("No results", "没有结果", "沒有結果")}</p>
        )}
        {head.cut && <p className={NOTE}>{w(`Showing the first ${limits.reader} lines`, `仅显示前 ${limits.reader} 行`, `僅顯示前 ${limits.reader} 行`)}</p>}
      </div>
    </FollowEnd>
  );
}

function clipValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** An argument summary (a few keys, short values) and the result text. */
function DetailView({ call, limits, note }: { call: ToolCall; limits: Limits; note?: string }) {
  const w = useWords();
  const entries = useMemo(() => Object.entries(call.args).filter(([key]) => key !== "_preview").slice(0, 8), [call.args]);
  const tail = useMemo(() => tailLines(call.output, limits.lastLines), [call.output, limits.lastLines]);
  const failed = call.status === "error";
  return (
    <FollowEnd label={toolVerb(call.name, w)} signal={call} follow={running(call)}>
      <div className="flex flex-col gap-3 px-4 py-3">
        <Clipped call={call} />
        {entries.length > 0 && (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
            {entries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate font-mono text-ink-2">{key}</dt>
                <dd className="whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{clipValue(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {failed && <p className={`${NOTE} font-medium text-red-ink`}>{stateLabel(call.status, w)}</p>}
        {tail.lines.length > 0 ? (
          <div className="border-t border-line pt-3">
            {tail.cut && <p className={`pb-1 ${NOTE}`}>{w(`Showing the last ${tail.lines.length} lines`, `仅显示最后 ${tail.lines.length} 行`, `僅顯示最後 ${tail.lines.length} 行`)}</p>}
            <div className={`${MONO} whitespace-pre-wrap [overflow-wrap:anywhere] ${failed ? "text-ink-2" : "text-ink"}`}>{tail.lines.join("\n")}</div>
          </div>
        ) : running(call) ? <p className={NOTE}>{w("Waiting for the result…", "等待结果…", "等待結果…")}</p> : null}
        {note && <p className={NOTE}>{note}</p>}
      </div>
    </FollowEnd>
  );
}

/** The window chrome for a step: its title tab and, for URLs and queries, the address row. */
export function stepChrome(call: ToolCall, w: Words): { tab: string; address: string | null } {
  const url = str(call.args.url);
  switch (stepKind(call.name)) {
    case "shell":
      return { tab: w("Terminal", "终端", "終端"), address: null };
    case "file":
      return { tab: fileName(str(call.args.path)) || w("File", "文件", "檔案"), address: null };
    case "search":
      return { tab: w("Search", "搜索", "搜尋"), address: str(call.args.query) || null };
    case "fetch":
      return { tab: url ? host(url) : w("Page", "网页", "網頁"), address: url || null };
    case "browser":
      return { tab: url ? host(url) : w("Browser", "浏览器", "瀏覽器"), address: url || null };
    default:
      return { tab: toolVerb(call.name, w), address: null };
  }
}

/** The content of the shown step (`index` in `calls`); `viewer` renders it for the larger expanded viewer. A browser
 * step lands here only when it is not the live one: a page card, since screenshots are not kept. */
export const StepContent = memo(function StepContent({ calls, index, viewer = false }: { calls: readonly ToolCall[]; index: number; viewer?: boolean }) {
  const w = useWords();
  const call = calls[index];
  const limits = viewer ? LIMITS.viewer : LIMITS.window;
  switch (stepKind(call.name)) {
    case "shell":
      // Keyed by the shown step: choosing another step scrolls its command into view again.
      return <Terminal key={call.id} calls={calls} index={index} limits={limits} />;
    case "file":
      return <FileView key={call.id} call={call} limits={limits} />;
    case "search":
    case "fetch":
      return <ReaderView key={call.id} call={call} limits={limits} />;
    case "browser":
      return <DetailView key={call.id} call={call} limits={limits} note={w("The screen of an earlier browser step is not kept.", "较早的浏览器步骤不保留画面。", "較早的瀏覽器步驟不保留畫面。")} />;
    default:
      return <DetailView key={call.id} call={call} limits={limits} />;
  }
});
