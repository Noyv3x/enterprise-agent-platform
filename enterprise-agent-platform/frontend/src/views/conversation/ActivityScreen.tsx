import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import AgentScreen from "../../components/ui/beautiful/primitives/AgentScreen";
import { parseUnifiedDiff, type DiffRow } from "../../components/ui/beautiful/primitives/CodeBlock";
import { useWords } from "../../words";
import { FILE_TOOLS, commandLine, str, tailLines } from "./computerView";
import type { ToolCall } from "./types";

/* The terminal and editor views of the computer panel. They reuse CodeBlock's look (mono 12.5px, 1.65 leading, a
 * hairline gutter, green/red row tints) and AgentScreen's frame; each renders a short bottom-anchored preview on the
 * card and a scrolling, follow-the-end listing in the expanded viewer. Only the tail of long text is rendered. */

/** Same stick rule as the conversation: following the end until the reader scrolls up past this distance. */
const STICK_PX = 120;
type Words = (en: string, zhCN?: string, zhTW?: string) => string;

const PREVIEW_ENTRIES = 3;
const FULL_ENTRIES = 40;
const PREVIEW_LINES = 24;
const FULL_LINES = 400;

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";
const MONO = "font-mono text-[12.5px] leading-[1.65]";

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

function stateLabel(status: ToolCall["status"], w: Words): string {
  if (status === "preparing") return w("Preparing", "准备中", "準備中");
  if (status === "running") return w("Running", "进行中", "進行中");
  if (status === "error") return w("Failed", "失败", "失敗");
  if (status === "cancelled") return w("Stopped", "已停止", "已停止");
  return w("Done", "已完成", "已完成");
}

function Note({ lines }: { lines: number }) {
  const w = useWords();
  return (
    <p className="px-3 pb-1 text-[12px] text-ink-2">
      {w(`Showing the last ${lines} lines`, `仅显示最后 ${lines} 行`, `僅顯示最後 ${lines} 行`)}
    </p>
  );
}

const TerminalEntry = memo(function TerminalEntry({ call, max }: { call: ToolCall; max: number }) {
  const w = useWords();
  // File tools show their content in the editor; here they are a single line.
  const tail = useMemo(() => tailLines(FILE_TOOLS.has(call.name) ? "" : call.output, max), [call.name, call.output, max]);
  const failed = call.status === "error";
  return (
    <div className={`${MONO} px-3 py-1.5`}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-ink">{commandLine(call)}</span>
        <span className={`mt-[0.35em] ${failed ? "text-red-ink" : "text-ink-2"}`}>
          <StateMark status={call.status} label={stateLabel(call.status, w)} />
        </span>
      </div>
      {tail.lines.length > 0 && (
        <>
          {tail.cut && <p className="mt-0.5 text-[12px] text-ink-2">{w(`… earlier output omitted (last ${tail.lines.length} lines shown)`, `… 较早的输出已省略（显示最后 ${tail.lines.length} 行）`, `… 較早的輸出已省略（顯示最後 ${tail.lines.length} 行）`)}</p>}
          <div className="whitespace-pre-wrap break-words text-ink-2">{tail.lines.join("\n")}</div>
        </>
      )}
      {failed && <p className="mt-0.5 text-[12px] font-medium text-red-ink">{stateLabel(call.status, w)}</p>}
      {call.truncated && <p className="mt-0.5 text-[12px] text-ink-2">{w("Live output limit reached; the final output follows when the command ends.", "实时输出已达上限，命令结束后会显示完整输出。", "即時輸出已達上限，命令結束後會顯示完整輸出。")}</p>}
    </div>
  );
});

/** The scrolling frame of the expanded viewer: follows the end until the reader scrolls up. */
function FollowEnd({ signal, role, label, children }: { signal: unknown; role?: "log"; label: string; children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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
      className="absolute inset-0 overflow-y-auto overscroll-contain bg-surface py-2"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
    >
      {children}
    </div>
  );
}

/** The card preview: the newest lines anchored to the bottom of a fixed frame. */
function Preview({ role, label, children }: { role?: "log"; label: string; children: ReactNode }) {
  return (
    <div role={role} aria-label={label} aria-live={role === "log" ? "off" : undefined} className="absolute inset-0 overflow-hidden bg-surface">
      <div className="absolute inset-x-0 bottom-0 py-2">{children}</div>
    </div>
  );
}

function Terminal({ calls, full }: { calls: readonly ToolCall[]; full: boolean }) {
  const w = useWords();
  const label = w("Terminal output", "终端输出", "終端輸出");
  const shown = calls.slice(-(full ? FULL_ENTRIES : PREVIEW_ENTRIES));
  const entries = shown.map((call, index) => (
    <TerminalEntry key={call.id} call={call} max={index === shown.length - 1 ? (full ? FULL_LINES : PREVIEW_LINES) : full ? 40 : 6} />
  ));
  const note = calls.length > shown.length && full ? <p className="px-3 pb-1 text-[12px] text-ink-2">{w(`Showing the last ${shown.length} commands`, `仅显示最近 ${shown.length} 条命令`, `僅顯示最近 ${shown.length} 條命令`)}</p> : null;
  if (!full) return <Preview role="log" label={label}>{entries}</Preview>;
  return <FollowEnd role="log" label={label} signal={calls}>{note}{entries}</FollowEnd>;
}

type Rows = { rows: DiffRow[]; cut: boolean };

/** The listing an editor call shows: written/read content as numbered lines, edits as removed and added blocks. */
function editorRows(call: ToolCall, max: number): Rows {
  if (call.name === "edit") {
    if (call.status === "done" && call.diff) {
      const rows = parseUnifiedDiff(call.diff).rows;
      return { rows: rows.slice(-max), cut: rows.length > max };
    }
    const edits = Array.isArray(call.args.edits) ? call.args.edits : [];
    const rows: DiffRow[] = [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const { oldText, newText } = edit as Record<string, unknown>;
      if (str(oldText)) for (const text of str(oldText).split("\n")) rows.push({ num: null, type: "del", text });
      if (str(newText)) for (const text of str(newText).split("\n")) rows.push({ num: null, type: "add", text });
    }
    return { rows: rows.slice(-max), cut: rows.length > max };
  }
  const text = call.name === "read" ? call.output : str(call.args.content) || str(call.args._preview);
  const tail = tailLines(text, max);
  return { rows: tail.lines.map((line, index) => ({ num: tail.first + index, type: "ctx" as const, text: line })), cut: tail.cut };
}

function Listing({ rows }: { rows: DiffRow[] }) {
  const digits = String(Math.max(0, ...rows.map((row) => row.num ?? 0))).length;
  const gutter = Math.max(20, digits * 7 + 6);
  return (
    <div className={`relative ${MONO} text-ink-2`}>
      <span className="pointer-events-none absolute inset-y-0 w-px bg-line" style={{ left: gutter }} />
      {rows.map((row, index) => {
        const add = row.type === "add";
        const del = row.type === "del";
        return (
          <div key={index} className={`relative grid items-start ${add ? "bg-green-tint" : del ? "bg-red-tint" : ""}`} style={{ gridTemplateColumns: `${gutter}px minmax(0,1fr)` }}>
            {(add || del) && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: add ? "var(--green)" : HATCH }} />}
            <span className={`select-none text-center text-[11px] ${add ? "text-green-ink" : del ? "text-red-ink" : "text-ink-2"}`}>{row.num ?? (add ? "+" : del ? "−" : "")}</span>
            <code className="break-words whitespace-pre-wrap pl-1 pr-3">{row.text || "\u200b"}</code>
          </div>
        );
      })}
    </div>
  );
}

function Editor({ call, full }: { call: ToolCall | null; full: boolean }) {
  const w = useWords();
  const max = full ? FULL_LINES : PREVIEW_LINES;
  const view = useMemo(() => (call ? editorRows(call, max) : { rows: [], cut: false }), [call, max]);
  const label = w("Editor", "编辑器", "編輯器");
  const path = call ? str(call.args.path) : "";
  const verb = !call ? "" : call.name === "write" ? w("Writing", "写入", "寫入") : call.name === "edit" ? w("Editing", "编辑", "編輯") : w("Reading", "读取", "讀取");
  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4 text-[12.5px]">
      <span className="truncate font-mono leading-none text-ink" title={path}>{path || label}</span>
      {call && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-2">
          <StateMark status={call.status} label={stateLabel(call.status, w)} />
          {call.status === "preparing" || call.status === "running" ? verb : stateLabel(call.status, w)}
        </span>
      )}
    </div>
  );
  const listing = (
    <>
      {view.cut && <Note lines={view.rows.length} />}
      {call ? <Listing rows={view.rows} /> : <p className="px-4 py-3 text-[12.5px] text-ink-2">{w("No file has been opened yet.", "尚未打开文件。", "尚未開啟檔案。")}</p>}
    </>
  );
  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      {header}
      <div className="relative min-h-0 flex-1">
        {full ? <FollowEnd label={path ? `${label}: ${path}` : label} signal={call}>{listing}</FollowEnd> : <Preview label={label}>{listing}</Preview>}
      </div>
    </div>
  );
}

/** Terminal or editor as an AgentScreen: a card with the newest lines, the full listing in the expanded viewer. */
export function ActivityScreen({ view, calls, editorCall, status, open, onOpenChange }: {
  view: "terminal" | "editor";
  calls: readonly ToolCall[];
  editorCall: ToolCall | null;
  status: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const w = useWords();
  const terminal = view === "terminal";
  const name = terminal ? w("Terminal", "终端", "終端") : w("Editor", "编辑器", "編輯器");
  const path = editorCall ? str(editorCall.args.path) : "";
  return (
    <section aria-label={name} className="flex flex-col gap-2.5">
      <AgentScreen
        agentName={terminal ? name : path.split("/").filter(Boolean).pop() || name}
        status={status}
        screen={terminal
          ? (calls.length ? <Terminal calls={calls} full={false} /> : <EmptyNote>{w("No commands yet. What the agent runs appears here.", "还没有命令。智能体执行的命令会显示在这里。", "還沒有命令。智慧體執行的命令會顯示在這裡。")}</EmptyNote>)
          : <Editor call={editorCall} full={false} />}
        viewerScreen={terminal
          ? (calls.length ? <Terminal calls={calls} full /> : <EmptyNote>{w("No commands yet. What the agent runs appears here.", "还没有命令。智能体执行的命令会显示在这里。", "還沒有命令。智慧體執行的命令會顯示在這裡。")}</EmptyNote>)
          : <Editor call={editorCall} full />}
        open={open}
        onOpenChange={onOpenChange}
        labels={{
          open: w("Open", "打开", "開啟"),
          collapse: w("Collapse", "收起", "收起"),
          connecting: w("Connecting", "正在连接", "正在連線"),
          screen: name,
        }}
      />
    </section>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex items-center justify-center bg-inset p-4 text-center text-[12.5px] text-ink-2">{children}</div>;
}
