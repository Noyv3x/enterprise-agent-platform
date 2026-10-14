import { memo, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Shimmer } from "../../components/ui/beautiful/atoms/Shimmer";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import type { DiffRow } from "../../components/ui/beautiful/primitives/CodeBlock";
import { LoaderGrid } from "../../components/ui/beautiful/primitives/LoadingState";
import { intlLocale } from "../../i18n";
import { useWords } from "../../words";
import { commandLine, fileName, headLines, host, parsePatch, stepKind, str, tailLines, type PatchRow } from "./computerView";
import { Markdown } from "./Markdown";
import { SiteMark } from "./SiteMark";
import type { ToolCall } from "./types";
import { engineList, failureDetail, failureShort, safeHref, siteOf, urlKey, visits, type WebFailure } from "./web";
import { McpLabelsContext, toolVerb, type McpLabels, type Words } from "./work";

/* What the computer window shows for one step, by kind: a terminal transcript, a file (a finished edit or write as
 * its unified patch with old/new line numbers), a search results page, a page the AI read, a page card for an older
 * browser step, or any other tool's arguments and result. Every view is a scrolling frame that follows the end while
 * the step streams (until the reader scrolls up) and reuses CodeBlock's look (mono 12.5px, 1.65 leading, a hairline
 * gutter, green/red row tints). Only part of long text is rendered. Search and page views read from the top. */

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

/** The window's scrolling frame: follows the end while `stick` holds; a reader scrolling up stops it. The process
 * output viewer uses it too. */
export function FollowEnd({ signal, follow, role, label, children }: { signal: unknown; follow: boolean; role?: "log"; label: string; children: ReactNode }) {
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

/** The listing a file step shows without a patch: written/read content as numbered lines, edits as removed and added
 * blocks (while the call streams, and for a write whose old file could not be compared). */
function fileRows(call: ToolCall, max: number): Rows {
  if (call.name === "edit") {
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

/** A unified patch in CodeBlock's Diff look (row tints, green bar / red hatch, hunk headers in ink-2) with two
 * gutters, the old and the new line number, inset 4px so the 3px bar never covers the old number; removed and added
 * rows are named for screen readers. */
function PatchListing({ rows }: { rows: PatchRow[] }) {
  const w = useWords();
  const digits = String(Math.max(0, ...rows.map((row) => Math.max(row.old ?? 0, row.new ?? 0)))).length;
  const gutter = Math.max(20, digits * 7 + 6);
  const added = w("Added", "新增", "新增");
  const removed = w("Removed", "删除", "刪除");
  return (
    <div className={`relative ${MONO} text-ink-2`}>
      <span className="pointer-events-none absolute inset-y-0 w-px bg-line" style={{ left: 4 + gutter * 2 }} />
      {rows.map((row, at) => {
        const add = row.type === "add";
        const del = row.type === "del";
        const number = `select-none text-center text-[11px] ${add ? "text-green-ink" : del ? "text-red-ink" : "text-ink-2"}`;
        return (
          <div key={at} className={`relative grid items-start pl-1 ${add ? "bg-green-tint" : del ? "bg-red-tint" : row.type === "hunk" && at > 0 ? "mt-2" : ""}`} style={{ gridTemplateColumns: `${gutter}px ${gutter}px minmax(0,1fr)` }}>
            {(add || del) && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: add ? "var(--green)" : HATCH }} />}
            <span aria-hidden className={number}>{row.old ?? ""}</span>
            <span aria-hidden className={number}>{row.new ?? ""}</span>
            <code className="break-words whitespace-pre-wrap pl-1 pr-3">
              {(add || del) && <span className="sr-only">{add ? added : removed}: </span>}
              {row.text || "\u200b"}
            </code>
          </div>
        );
      })}
    </div>
  );
}

function FileView({ call, limits }: { call: ToolCall; limits: Limits }) {
  const w = useWords();
  // A finished edit or write with a patch shows it; otherwise (streaming, no patch) the arguments or content.
  const patch = useMemo(() => {
    if (!call.patch || call.status !== "done" || (call.name !== "edit" && call.name !== "write")) return null;
    const parsed = parsePatch(call.patch);
    return parsed.rows.length ? { ...parsed, rows: parsed.rows.slice(0, limits.rows), clipped: parsed.rows.length > limits.rows } : null;
  }, [call, limits.rows]);
  const view = useMemo(() => (patch ? null : fileRows(call, limits.rows)), [patch, call, limits.rows]);
  const path = str(call.args.path);
  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={path}>{path || "…"}</span>
        {patch && (
          <span className="inline-flex shrink-0 items-center gap-2 font-mono tabular-nums">
            <span className="text-green-ink">+{patch.added}</span>
            <span className="text-red-ink">−{patch.removed}</span>
            <span className="sr-only">{w(`${patch.added} added, ${patch.removed} removed`, `新增 ${patch.added} 行，删除 ${patch.removed} 行`, `新增 ${patch.added} 行，刪除 ${patch.removed} 行`)}</span>
          </span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1.5 text-ink-2">
          <StateMark status={call.status} label={stateLabel(call.status, w)} />
          {stateLabel(call.status, w)}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* The patch opens at its first hunk: a fresh frame, no longer following the streamed content's end. */}
        <FollowEnd key={patch ? "patch" : "content"} label={path ? `${w("File", "文件", "檔案")}: ${path}` : w("File", "文件", "檔案")} signal={call} follow={running(call)}>
          <div className="py-2">
            <Clipped call={call} className="px-3 pb-1" />
            {patch ? (
              <>
                {(call.patchCut || patch.cut) && <p className={`px-3 pb-1 ${NOTE}`}>{w("Only part of this change is shown", "仅显示部分改动", "僅顯示部分改動")}</p>}
                {patch.clipped && <p className={`px-3 pb-1 ${NOTE}`}>{w(`Showing the first ${patch.rows.length} lines of the change`, `仅显示改动的前 ${patch.rows.length} 行`, `僅顯示改動的前 ${patch.rows.length} 行`)}</p>}
                <PatchListing rows={patch.rows} />
              </>
            ) : view && (
              <>
                {view.cut && <p className={`px-3 pb-1 ${NOTE}`}>{w(`Showing the last ${view.rows.length} lines`, `仅显示最后 ${view.rows.length} 行`, `僅顯示最後 ${view.rows.length} 行`)}</p>}
                {view.rows.length ? <Listing rows={view.rows} />
                  : <p className={`px-3 ${NOTE}`}>{running(call) ? w("Waiting for content…", "等待内容…", "等待內容…") : w("No content", "没有内容", "沒有內容")}</p>}
              </>
            )}
            {call.status === "error" && call.output && <p className={`px-3 pt-2 ${MONO} text-red-ink`}>{call.output}</p>}
          </div>
        </FollowEnd>
      </div>
    </div>
  );
}

/** http(s) URLs in plain text as links that open a new tab (an older search step's text output). */
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

/** Rows of a web view enter one after another (ContextCards' stagger); reduced motion shows them at once. */
const enter = (at: number) => ({ animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${Math.min(at, 8) * 45}ms both` });

const OPEN_ICON = <path d="M7 17L17 7M7 7h10v10" />;

/** A result's address after its site: "news.cn › politics › 2026-10". */
function crumbs(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean).slice(0, 3).map((segment) => {
      let text = segment;
      try {
        text = decodeURIComponent(segment);
      } catch {
        // keep the encoded segment
      }
      return text.length > 24 ? `${text.slice(0, 24)}…` : text;
    });
    return segments.join(" › ");
  } catch {
    return "";
  }
}

/** Placeholder rows while the step runs: shaped like what will arrive, pulsing gently. */
function Skeleton({ rows, kind }: { rows: number; kind: "result" | "text" }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, at) => (kind === "result" ? (
        <div key={at} className="flex flex-col gap-2 border-b border-line px-4 py-3.5" style={enter(at)}>
          <div className="flex items-center gap-2">
            <span className="size-5 rounded-full bg-hover-2 animate-pulse motion-reduce:animate-none" />
            <span className="h-2.5 w-24 rounded-full bg-hover-2 animate-pulse motion-reduce:animate-none" />
          </div>
          <span className="h-3 w-3/4 rounded-full bg-hover-2 animate-pulse motion-reduce:animate-none" />
          <span className="h-2.5 w-full rounded-full bg-hover animate-pulse motion-reduce:animate-none" />
          <span className="h-2.5 w-2/3 rounded-full bg-hover animate-pulse motion-reduce:animate-none" />
        </div>
      ) : (
        <span key={at} className="mb-2.5 block h-2.5 rounded-full bg-hover-2 animate-pulse motion-reduce:animate-none" style={{ ...enter(at), width: `${[92, 100, 84, 96, 60][at % 5]}%` }} />
      )))}
    </div>
  );
}

/** Why a page (or a search) could not be read, calmly: what the site did, what was tried, what happens next, and the
 * original page for the person to open. Never the alarming red of a broken step: the site said no. */
function WebNotice({ failure, search }: { failure: WebFailure; search: boolean }) {
  const w = useWords();
  const site = siteOf(failure.url) || failure.host;
  const title = search ? w("Search is unavailable right now", "搜索暂时不可用", "搜尋暫時無法使用")
    : site ? `${site} ${failureShort(failure, w)}` : w("The page could not be opened", "无法打开这个网页", "無法開啟這個網頁");
  const lines = search ? [failure.message].filter(Boolean) : failureDetail(failure, w);
  const facts = [
    failure.protection,
    failure.status ? `HTTP ${failure.status}` : "",
    failure.triedBrowser === true ? w("Browser tried", "已尝试浏览器", "已嘗試瀏覽器") : failure.triedBrowser === false ? w("Browser not tried", "未尝试浏览器", "未嘗試瀏覽器") : "",
  ].filter(Boolean);
  return (
    <div className="flex max-w-[560px] flex-col items-start gap-3 px-5 py-6">
      <span aria-hidden className="flex size-9 items-center justify-center rounded-card bg-inset text-ink-2 shadow-hairline" style={enter(0)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {failure.error === "blocked"
            ? <><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" /><path d="M9.5 12h5" /></>
            : <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>}
        </svg>
      </span>
      <div style={enter(1)}>
        <h2 className="text-[15px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{title}</h2>
        {lines.map((line, at) => <p key={at} className="mt-1 text-[13px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{line}</p>)}
      </div>
      {facts.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" style={enter(2)} aria-label={w("Details", "详情", "詳情")}>
          {facts.map((fact) => <li key={fact}><StatusPill dot={false} className="h-6 px-2 text-[12px]">{fact}</StatusPill></li>)}
        </ul>
      )}
      {!search && safeHref(failure.url) && (
        <a
          href={safeHref(failure.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface px-3 text-[13px] font-medium text-ink shadow-btn transition-colors duration-100 hover:bg-hover touch:h-11"
          style={enter(3)}
        >
          {w("Open the original page", "打开原网页", "開啟原網頁")}
          <svg aria-hidden width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{OPEN_ICON}</svg>
        </a>
      )}
    </div>
  );
}

/** A search step as a results page: upstream SearchList's input row holding the query, then one row per result — its
 * site's monogram, site and address, the title as a link and the snippet — with what became of the page later in the
 * same run (read, or could not be opened). Skeleton rows while it runs; an empty state naming unavailable engines. */
function SearchView({ calls, index, limits }: { calls: readonly ToolCall[]; index: number; limits: Limits }) {
  const w = useWords();
  const call = calls[index];
  const search = call.web?.kind === "search" ? call.web : null;
  const failure = call.web?.kind === "failure" ? call.web : null;
  const later = useMemo(() => visits(calls.slice(index + 1)), [calls, index]);
  const legacy = useMemo(() => (search?.text ? headLines(search.text, limits.reader) : null), [search?.text, limits.reader]);
  const query = str(call.args.query) || search?.query || "";
  const busy = running(call);
  const count = search?.results.length ?? 0;
  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
          {busy ? <LoaderGrid variant="Orbit" /> : (
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={query}>{query || "…"}</span>
        <span className="shrink-0 text-[12px] text-ink-2 tabular-nums">
          {busy ? <Shimmer>{w("Searching…", "正在搜索…", "正在搜尋…")}</Shimmer>
            : count ? w(`${count} ${count === 1 ? "result" : "results"}`, `${count} 条结果`, `${count} 筆結果`) : null}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <FollowEnd label={w("Search results", "搜索结果", "搜尋結果")} signal={call} follow={false}>
          <Clipped call={call} className="px-4 pt-2" />
          {busy ? <Skeleton rows={4} kind="result" />
            : failure ? <WebNotice failure={failure} search />
              : legacy ? (
                <div className="flex flex-col gap-2 px-4 py-3">
                  <div className="whitespace-pre-wrap text-[13px] leading-[1.7] text-ink [overflow-wrap:anywhere]">{linkify(legacy.text)}</div>
                  {legacy.cut && <p className={NOTE}>{w(`Showing the first ${limits.reader} lines`, `仅显示前 ${limits.reader} 行`, `僅顯示前 ${limits.reader} 行`)}</p>}
                </div>
              ) : count ? (
                <>
                  <ol className="flex flex-col">
                    {search!.results.map((result, at) => {
                      const site = siteOf(result.url);
                      const path = crumbs(result.url);
                      const visit = later.get(urlKey(result.url));
                      return (
                        <li key={`${at}-${result.url}`} className="border-b border-line px-4 py-3" style={enter(at)}>
                          <div className="flex items-center gap-2">
                            <SiteMark url={result.url} className="size-5 text-[10px]" />
                            <span className="min-w-0 flex-1 truncate text-[12px] leading-tight">
                              <span className="font-medium text-ink">{site}</span>
                              {path && <span className="font-mono text-[11px] text-ink-2"> › {path}</span>}
                            </span>
                            {visit === "read" && <StatusPill tone="green" className="h-5.5 px-2 text-[11.5px]">{w("Read", "已阅读", "已閱讀")}</StatusPill>}
                            {visit === "failed" && <StatusPill dot={false} className="h-5.5 px-2 text-[11.5px]">{w("Could not open", "无法打开", "無法開啟")}</StatusPill>}
                          </div>
                          {safeHref(result.url) ? (
                            <a
                              href={safeHref(result.url)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1.5 block text-[14px] font-medium leading-snug text-accent-ink [overflow-wrap:anywhere] hover:underline hover:underline-offset-2"
                            >
                              {result.title || site}
                            </a>
                          ) : <p className="mt-1.5 text-[14px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{result.title || site}</p>}
                          {result.description && <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{result.description}</p>}
                        </li>
                      );
                    })}
                  </ol>
                  {search!.unresponsive.length > 0 && (
                    <p className={`px-4 py-3 ${NOTE}`}>{w(`Some engines did not answer: ${engineList(search!.unresponsive, w)}`, `部分搜索引擎没有响应：${engineList(search!.unresponsive, w)}`, `部分搜尋引擎沒有回應：${engineList(search!.unresponsive, w)}`)}</p>
                  )}
                </>
              ) : search ? (
                // upstream SearchList's empty state
                <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center" style={{ animation: "fade-in 250ms ease-out both" }}>
                  <span aria-hidden className="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                  </span>
                  <span className="text-[13px] font-medium text-ink">{w("No results came back", "没有搜到结果", "沒有搜到結果")}</span>
                  <span className="max-w-[340px] text-[12px] text-ink-2">
                    {search.unresponsive.length
                      ? w(`These engines are unavailable right now: ${engineList(search.unresponsive, w)}.`, `这些搜索引擎暂时不可用：${engineList(search.unresponsive, w)}。`, `這些搜尋引擎暫時無法使用：${engineList(search.unresponsive, w)}。`)
                      : w("The search engines found nothing for this query.", "搜索引擎没有找到与这个查询相关的结果。", "搜尋引擎沒有找到與這個查詢相關的結果。")}
                  </span>
                </div>
              ) : <p className={`px-4 py-3 ${NOTE}`}>{call.status === "cancelled" ? w("The search was stopped.", "搜索已停止。", "搜尋已停止。") : w("No results", "没有结果", "沒有結果")}</p>}
        </FollowEnd>
      </div>
    </div>
  );
}

/** A page the AI read: its site (and 经浏览器打开 when a real browser had to open it), title, length and the original
 * as a link, then the start of the page as Markdown (images never load) with a note when only part is shown. */
function PageView({ call }: { call: ToolCall }) {
  const w = useWords();
  const page = call.web?.kind === "page" ? call.web : null;
  const failure = call.web?.kind === "failure" ? call.web : null;
  const url = page?.url || str(call.args.url);
  const site = siteOf(url);
  const busy = running(call);
  const number = new Intl.NumberFormat(intlLocale());
  if (failure) {
    return <FollowEnd label={w("Page", "网页", "網頁")} signal={call} follow={false}><WebNotice failure={failure} search={false} /></FollowEnd>;
  }
  const shown = page?.excerpt.length ?? 0;
  // The excerpt usually opens with the title the header already shows.
  const lines = page ? page.excerpt.trimStart().split("\n") : [];
  const body = page?.title && lines[0]?.replace(/^#+\s*/, "").trim() === page.title.trim() ? lines.slice(1).join("\n").trim() : page?.excerpt.trim() ?? "";
  return (
    <FollowEnd label={page?.title ? `${w("Page", "网页", "網頁")}: ${page.title}` : w("Page", "网页", "網頁")} signal={call} follow={false}>
      <article className="max-w-[680px] px-5 py-4">
        <div className="flex min-w-0 items-center gap-2" style={enter(0)}>
          {site && <SiteMark url={url} className="size-5 text-[10px]" />}
          <span className="min-w-0 truncate text-[12.5px] font-medium text-ink-2">{site}</span>
          {page?.via === "browser" && <StatusPill tone="accent" className="h-5.5 shrink-0 px-2 text-[11.5px]">{w("Opened in a browser", "经浏览器打开", "經瀏覽器開啟")}</StatusPill>}
        </div>
        {busy ? (
          <>
            <p className="mt-2 text-[16px] font-semibold"><Shimmer>{w("Opening the page…", "正在打开网页…", "正在開啟網頁…")}</Shimmer></p>
            <div className="mt-4"><Skeleton rows={7} kind="text" /></div>
          </>
        ) : page ? (
          <>
            <h2 className="mt-2 text-[17px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]" style={enter(1)}>{page.title || site}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2" style={enter(2)}>
              {page.chars !== null && <span className="tabular-nums">{w(`${number.format(page.chars)} characters`, `约 ${number.format(page.chars)} 字`, `約 ${number.format(page.chars)} 字`)}</span>}
              {safeHref(page.url) && (
                <a href={safeHref(page.url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline hover:underline-offset-2 touch:min-h-11">
                  {w("Open the original", "打开原网页", "開啟原網頁")}
                  <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{OPEN_ICON}</svg>
                </a>
              )}
            </div>
            <div className="mt-4 border-t border-line pt-4" style={enter(3)}>
              {body ? <div className="bui-prose text-[13.5px] leading-[1.7] text-ink"><Markdown content={body} /></div>
                : <p className={NOTE}>{w("The page has no readable text.", "这个网页没有可读取的文字。", "這個網頁沒有可讀取的文字。")}</p>}
              {page.chars !== null && page.chars > shown + 1 && (
                <p className={`mt-4 ${NOTE}`}>{w(`Showing the first ${number.format(shown)} of about ${number.format(page.chars)} characters.`, `这里只显示开头的 ${number.format(shown)} 字（全文约 ${number.format(page.chars)} 字）。`, `這裡只顯示開頭的 ${number.format(shown)} 字（全文約 ${number.format(page.chars)} 字）。`)}</p>
              )}
              {page.truncated && <p className={`mt-1 ${NOTE}`}>{w("The page is long; the AI read only its first part.", "网页较长，AI 只读取了前面的部分。", "網頁較長，AI 只讀取了前面的部分。")}</p>}
            </div>
          </>
        ) : <p className={`mt-3 ${NOTE}`}>{call.status === "cancelled" ? w("Reading was stopped.", "已停止阅读。", "已停止閱讀。") : w("Nothing was read.", "没有读取到内容。", "沒有讀取到內容。")}</p>}
      </article>
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
  const labels = useContext(McpLabelsContext);
  const entries = useMemo(() => Object.entries(call.args).filter(([key]) => key !== "_preview").slice(0, 8), [call.args]);
  const tail = useMemo(() => tailLines(call.output, limits.lastLines), [call.output, limits.lastLines]);
  const failed = call.status === "error";
  return (
    <FollowEnd label={toolVerb(call.name, w, call.args, labels)} signal={call} follow={running(call)}>
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
export function stepChrome(call: ToolCall, w: Words, labels: McpLabels = {}): { tab: string; address: string | null } {
  const url = str(call.args.url);
  switch (stepKind(call.name)) {
    case "shell":
      return { tab: w("Terminal", "终端", "終端"), address: null };
    case "file":
      return { tab: fileName(str(call.args.path)) || w("File", "文件", "檔案"), address: null };
    case "search":
      // the query sits in the search view's own bar
      return { tab: w("Search", "搜索", "搜尋"), address: null };
    case "fetch":
      return { tab: url ? siteOf(url) : w("Page", "网页", "網頁"), address: url || null };
    case "browser":
      return { tab: url ? host(url) : w("Browser", "浏览器", "瀏覽器"), address: url || null };
    default:
      return { tab: toolVerb(call.name, w, call.args, labels), address: null };
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
      return <SearchView key={call.id} calls={calls} index={index} limits={limits} />;
    case "fetch":
      return <PageView key={call.id} call={call} />;
    case "browser":
      return <DetailView key={call.id} call={call} limits={limits} note={w("The screen of an earlier browser step is not kept.", "较早的浏览器步骤不保留画面。", "較早的瀏覽器步驟不保留畫面。")} />;
    default:
      return <DetailView key={call.id} call={call} limits={limits} />;
  }
});
