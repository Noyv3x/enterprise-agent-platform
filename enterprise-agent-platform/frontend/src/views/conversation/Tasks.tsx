import { useContext, useEffect, useId, useRef, useState } from "react";
import { request } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import { ConfirmDialog, Icon, Notice, Sheet } from "../../components/ui/beautiful/controls";
import { FauxWindow, ScreenViewer } from "../../components/ui/beautiful/primitives/AgentScreen";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import TaskRows, { type TaskRow } from "../../components/ui/beautiful/primitives/TaskRows";
import { useWords } from "../../words";
import { FollowEnd } from "./ActivityScreen";
import { ComputerContext } from "./computerView";
import { Markdown } from "./Markdown";
import {
  TasksContext, agentTypeLabel, isRunning, noticeLine, taskElapsed, taskStatusLabel, taskTitle, tokenCount,
  type TaskOutput, type TaskView,
} from "./taskState";
import type { Message } from "./types";
import { errorText } from "./useConversation";
import { parseWork } from "./work";
import { WorkView, useNow } from "./WorkView";

/* The personal AI's background tasks: the computer panel's list, the process output viewer, the subagent sheet,
 * the stop confirmation and the `task_notice` row. State lives in useConversation; these views only read it. */

const PILL_TONE: Record<TaskView["status"], "accent" | "green" | "red" | "neutral" | "orange"> = {
  running: "accent", completed: "green", failed: "red", stopped: "neutral", interrupted: "orange",
};

export function TaskPill({ task }: { task: TaskView }) {
  const w = useWords();
  return <StatusPill tone={PILL_TONE[task.status]} className="h-5.5 shrink-0 text-[12px]">{taskStatusLabel(task, w)}</StatusPill>;
}

/** Tasks shown before "Show all"; running ones are always listed. */
const RECENT = 6;

/** The computer panel's 后台任务 section: running tasks, then recent ones. A process opens its output, an agent its
 * sheet. */
export function BackgroundTasks() {
  const w = useWords();
  const tasks = useContext(TasksContext);
  const [all, setAll] = useState(false);
  const headingId = useId();
  const running = tasks ? tasks.sorted.filter(isRunning).length : 0;
  const now = useNow(running > 0);
  if (!tasks) return null;
  const { sorted } = tasks;
  const shown = all ? sorted : sorted.filter((task, index) => isRunning(task) || index < RECENT);
  const rows: TaskRow[] = shown.map((task) => {
    const time = taskElapsed(task, now);
    return {
      key: task.id,
      label: taskTitle(task),
      amount: [task.id, task.kind === "agent" ? agentTypeLabel(task.agent_type, w) : null, time].filter(Boolean).join(" · "),
      status: task.status === "running" ? "running" : task.status === "completed" ? "done" : task.status === "failed" ? "failed" : "idle",
      pill: task.status === "completed" ? undefined
        : { tone: PILL_TONE[task.status], label: task.status === "failed" && task.exit_code !== null ? w(`Failed · exit ${task.exit_code}`, `失败 · 退出码 ${task.exit_code}`, `失敗 · 結束代碼 ${task.exit_code}`)
          : task.status === "interrupted" ? w("Interrupted", "已中断", "已中斷") : taskStatusLabel(task, w) },
      details: [],
      onSelect: () => tasks.open(task.id),
    };
  });

  let body;
  if (tasks.error && !tasks.loaded) {
    body = (
      <Notice tone="danger" title={w("Background tasks could not be loaded", "无法加载后台任务", "無法載入背景任務")}
        action={<Button variant="secondary" size="sm" onClick={tasks.reload}>{w("Retry", "重试", "重試")}</Button>}>
        {tasks.error}
      </Notice>
    );
  } else if (!tasks.loaded && !sorted.length) {
    body = <LoadingState variant="Dots" label={w("Loading background tasks", "正在加载后台任务", "正在載入背景任務")} className="py-1" />;
  } else if (!sorted.length) {
    body = (
      <p className="text-[12px] leading-[1.5] text-ink-2">
        {w("Commands the agent keeps running in the background and the subagents it delegates to appear here.", "智能体在后台运行的命令和分派的子智能体会显示在这里。", "智慧體在背景執行的命令和分派的子智慧體會顯示在這裡。")}
      </p>
    );
  } else {
    body = <TaskRows variant="List" className="task-rows-stacked" rows={rows} ariaLabel={w("Background tasks", "后台任务", "背景任務")} labels={{ completed: w("Completed", "已完成", "已完成"), failed: w("Failed", "失败", "失敗") }} />;
  }

  return (
    <section aria-labelledby={headingId} className="flex shrink-0 flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <h3 id={headingId} className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-2">
          {running > 0
            ? w(`Background tasks · ${running} running`, `后台任务 · ${running} 个运行中`, `背景任務 · ${running} 個執行中`)
            : w("Background tasks", "后台任务", "背景任務")}
        </h3>
        {sorted.length > shown.length || all ? (
          <Button variant="quiet" size="xs" className="shrink-0 text-ink-2" onClick={() => setAll(!all)}>
            {all ? w("Show fewer", "收起", "收起") : w(`Show all ${sorted.length}`, `显示全部 ${sorted.length} 个`, `顯示全部 ${sorted.length} 個`)}
          </Button>
        ) : null}
      </div>
      {body}
    </section>
  );
}

/** The viewer keeps at most this much output; earlier text is dropped with a note. */
const OUTPUT_KEEP = 512 * 1024;
const WAIT_MS = 25_000;
/** A long poll that returns early without news waits this long before the next one. */
const QUIET_MS = 1000;

interface OutputState {
  text: string;
  /** only the latest output is shown: the first read started at the retained tail, or the viewer dropped text */
  cut: boolean;
  /** the retention cap dropped output the viewer had not read yet */
  dropped: boolean;
  eof: boolean;
  loaded: boolean;
  error: string;
}

const NO_OUTPUT: OutputState = { text: "", cut: false, dropped: false, eof: false, loaded: false, error: "" };

/** Long-polls a process's output while mounted: the retained tail first, then each next window until the end. */
function useTaskOutput(id: string, attempt: number): OutputState {
  const [state, setState] = useState(NO_OUTPUT);
  // The cursor survives a retry so it continues where the stream stopped.
  const next = useRef(-1);
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, error: "" }));
    void (async () => {
      try {
        for (;;) {
          const offset = next.current;
          const started = Date.now();
          const page = await request<TaskOutput>(
            `/api/tasks/${encodeURIComponent(id)}/output?offset=${offset}${offset < 0 ? "" : `&wait_ms=${WAIT_MS}`}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          next.current = page.next_offset;
          setState((current) => {
            let text = current.text + page.data;
            let cut = current.cut || (offset < 0 && page.offset_start > 0);
            if (text.length > OUTPUT_KEEP) {
              // Cut at a line start so no partial line or character remains.
              text = text.slice(text.indexOf("\n", text.length - OUTPUT_KEEP) + 1);
              cut = true;
            }
            return { text, cut, dropped: current.dropped || (offset >= 0 && page.offset_start > offset), eof: page.eof, loaded: true, error: "" };
          });
          if (page.eof) return;
          if (!page.data && Date.now() - started < QUIET_MS) await new Promise((resolve) => window.setTimeout(resolve, QUIET_MS));
          if (controller.signal.aborted) return;
        }
      } catch (reason) {
        if (!controller.signal.aborted) setState((current) => ({ ...current, loaded: true, error: errorText(reason) }));
      }
    })();
    return () => controller.abort();
  }, [id, attempt]);
  return state;
}

const MONO = "font-mono text-[12.5px] leading-[1.65]";
const NOTE = "text-[12px] text-ink-2";

/** A process's output as a read-only terminal in the expanded viewer's frame; polls only while open. */
function ProcessViewer({ task, onClose, onStop }: { task: TaskView; onClose: () => void; onStop: () => void }) {
  const w = useWords();
  const [attempt, setAttempt] = useState(0);
  const output = useTaskOutput(task.id, attempt);
  const running = isRunning(task);
  const now = useNow(running);
  const time = taskElapsed(task, now);
  return (
    <ScreenViewer
      title={`${task.id} · ${taskTitle(task)}`}
      status={<TaskPill task={task} />}
      collapseLabel={w("Close output", "关闭输出", "關閉輸出")}
      onClose={onClose}
      focusClose
      controls={running ? <Button variant="secondary" size="sm" className="touch:h-11" onClick={onStop}>{w("Stop task", "停止任务", "停止任務")}</Button> : undefined}
      inputs={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 pb-1 text-[12px] text-ink-2">
          {time && <span className="font-mono tabular-nums">{running ? w(`Running for ${time}`, `已运行 ${time}`, `已執行 ${time}`) : w(`Ran for ${time}`, `运行了 ${time}`, `執行了 ${time}`)}</span>}
          {task.exit_code !== null && <span className="font-mono tabular-nums">{w(`Exit code ${task.exit_code}`, `退出码 ${task.exit_code}`, `結束代碼 ${task.exit_code}`)}</span>}
          {running && <span>{w("Closing this viewer does not stop the task.", "关闭查看器不会停止任务。", "關閉檢視器不會停止任務。")}</span>}
        </div>
      }
    >
      <div className="relative overflow-hidden" style={{ width: "min(960px, 90vw)", height: "min(560px, calc(100vh - 200px))" }}>
        <FauxWindow tabs={[{ id: task.id, label: w("Terminal", "终端", "終端") }]}>
          <FollowEnd role="log" label={w("Task output", "任务输出", "任務輸出")} signal={output.text} follow>
            <div className={`${MONO} px-3 py-2`}>
              <p className="whitespace-pre-wrap break-words font-medium text-ink">$ {task.label}</p>
              {output.cut && <p className={`mt-0.5 ${NOTE}`}>{w("… showing the latest output", "… 仅显示最近的输出", "… 僅顯示最近的輸出")}</p>}
              {output.dropped && <p className={`mt-0.5 ${NOTE}`}>{w("Some output was dropped by the retention limit.", "部分输出超出保留上限，已丢弃。", "部分輸出超出保留上限，已捨棄。")}</p>}
              {output.text && <div className="whitespace-pre-wrap break-words text-ink-2">{output.text}</div>}
              {!output.loaded ? <p className={NOTE}>{w("Reading output…", "正在读取输出…", "正在讀取輸出…")}</p>
                : !output.text && !output.error ? <p className={NOTE}>{running ? w("No output yet", "还没有输出", "還沒有輸出") : w("No output", "没有输出", "沒有輸出")}</p> : null}
              {output.eof && !running && <p className={`mt-1 ${NOTE}`}>{w(`— ${taskStatusLabel(task, w)} —`, `— ${taskStatusLabel(task, w)} —`, `— ${taskStatusLabel(task, w)} —`)}</p>}
              {output.error && (
                <div className="mt-2 flex flex-wrap items-center gap-2 font-sans">
                  <p role="alert" className="text-[12.5px] text-red-ink">{output.error}</p>
                  <Button variant="secondary" size="sm" className="touch:h-11" onClick={() => setAttempt((value) => value + 1)}>{w("Retry", "重试", "重試")}</Button>
                </div>
              )}
            </div>
          </FollowEnd>
        </FauxWindow>
      </div>
    </ScreenViewer>
  );
}

interface TaskDetail {
  task: TaskView;
  work?: unknown;
  result?: string;
}

/** The task's detail, fetched on open and again after each stream update (a newer request supersedes nothing: one
 * runs at a time and a pending change fetches once more). */
function useTaskDetail(id: string, version: unknown) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const flight = useRef({ busy: false, again: false, alive: true });
  useEffect(() => {
    const current = flight.current;
    current.alive = true;
    return () => {
      current.alive = false;
    };
  }, []);
  useEffect(() => {
    const current = flight.current;
    if (current.busy) {
      current.again = true;
      return;
    }
    const run = () => {
      current.busy = true;
      current.again = false;
      request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`)
        .then((result) => {
          if (!current.alive) return;
          setDetail(result);
          setError("");
        })
        .catch((reason: unknown) => {
          if (current.alive) setError(errorText(reason));
        })
        .finally(() => {
          current.busy = false;
          if (current.alive && current.again) run();
        });
    };
    run();
  }, [id, version, attempt]);
  return { detail, error, retry: () => setAttempt((value) => value + 1) };
}

const ASSIGNMENT_LIMIT = 1200;

/** A subagent: its assignment, its work trace (WorkView) and its report as Markdown; Stop while it runs. */
function SubagentSheet({ task, onClose, onStop }: { task: TaskView; onClose: () => void; onStop: () => void }) {
  const w = useWords();
  const running = isRunning(task);
  const now = useNow(running);
  const { detail, error, retry } = useTaskDetail(task.id, task);
  const parsed = detail ? parseWork(detail.work, running) : null;
  // A finished subagent's trace ends when the task ended, even if its record carries no end.
  const ended = task.ended_at ? Date.parse(task.ended_at) : NaN;
  const trace = parsed && parsed.endedAt === null && !Number.isNaN(ended) ? { ...parsed, endedAt: ended } : parsed;
  const report = detail?.result || task.result_preview;
  const time = taskElapsed(task, now);
  const heading = "text-[12.5px] font-medium text-ink-2";
  const assignment = task.label.length > ASSIGNMENT_LIMIT ? `${task.label.slice(0, ASSIGNMENT_LIMIT)}…` : task.label;
  return (
    <Sheet
      open
      onClose={onClose}
      width={520}
      title={`${task.id} · ${task.name || agentTypeLabel(task.agent_type, w)}`}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-5 items-center rounded-chip bg-field px-1.5 text-[11px] font-medium text-ink-2 shadow-hairline">{agentTypeLabel(task.agent_type, w)}</span>
          <TaskPill task={task} />
          {time && <span className="font-mono text-[12px] tabular-nums">{time}</span>}
          {task.usage && <span className="text-[12px] tabular-nums">{tokenCount(task.usage.total_tokens, w)}</span>}
        </span>
      }
      footer={running ? (
        <Button variant="secondary" size="sm" className="touch:h-11" onClick={onStop}>{w("Stop subagent", "停止子智能体", "停止子智慧體")}</Button>
      ) : undefined}
    >
      {/* Focus starts at the content (not a tab stop, so no ring), never at Stop. */}
      <div data-autofocus tabIndex={-1} className="flex flex-col gap-5" style={{ outline: "none" }}>
        {assignment && (
          <section className="flex flex-col gap-1.5">
            <h3 className={heading}>{w("Assignment", "任务", "任務")}</h3>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{assignment}</p>
          </section>
        )}
        <section className="flex flex-col gap-1.5">
          <h3 className={heading}>{w("Work", "工作过程", "工作過程")}</h3>
          {error && !detail ? (
            <Notice tone="danger" title={w("The work could not be loaded", "无法加载工作过程", "無法載入工作過程")}
              action={<Button variant="secondary" size="sm" onClick={retry}>{w("Retry", "重试", "重試")}</Button>}>
              {error}
            </Notice>
          ) : !detail ? (
            <LoadingState variant="Dots" label={w("Loading work", "正在加载工作过程", "正在載入工作過程")} className="py-1" />
          ) : trace && trace.items.length ? (
            // The subagent's steps are not the conversation's runs: no "View in computer".
            <ComputerContext.Provider value={null}>
              <WorkView trace={trace} working={running} run={0} />
            </ComputerContext.Provider>
          ) : (
            <p className="text-[12.5px] text-ink-2">{running ? w("No steps yet", "还没有步骤", "還沒有步驟") : w("No recorded steps", "没有记录的步骤", "沒有記錄的步驟")}</p>
          )}
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className={heading}>{w("Report", "报告", "報告")}</h3>
          {report ? (
            <div className="bui-prose text-[13px] leading-relaxed text-ink"><Markdown content={report} /></div>
          ) : (
            <p className="text-[12.5px] text-ink-2">
              {running ? w("The report appears here when the subagent finishes.", "子智能体完成后，报告会显示在这里。", "子智慧體完成後，報告會顯示在這裡。")
                : w("No report", "没有报告", "沒有報告")}
            </p>
          )}
        </section>
      </div>
    </Sheet>
  );
}

/** The opened task (output viewer or sheet) and its stop confirmation. */
export function TaskOverlay({ task, onClose, onStop }: { task: TaskView; onClose: () => void; onStop: (id: string) => Promise<unknown> }) {
  const w = useWords();
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const running = isRunning(task);
  // A task that ends while the confirmation is open needs no stop any more.
  if (confirming && !running && !stopping) setConfirming(false);
  const ask = () => {
    setError("");
    setConfirming(true);
  };
  const stop = async () => {
    setStopping(true);
    setError("");
    try {
      await onStop(task.id);
      setConfirming(false);
      // The Stop control that opened the confirmation is gone now; focus the open viewer's or sheet's close control.
      window.requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        [...document.querySelectorAll<HTMLElement>("[data-viewer-close], [role=dialog] [data-modal-close]")].pop()?.focus();
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setStopping(false);
    }
  };
  const agent = task.kind === "agent";
  return (
    <>
      {agent ? <SubagentSheet task={task} onClose={onClose} onStop={ask} /> : <ProcessViewer task={task} onClose={onClose} onStop={ask} />}
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={agent ? w(`Stop ${task.id}?`, `停止子智能体 ${task.id}？`, `停止子智慧體 ${task.id}？`) : w(`Stop ${task.id}?`, `停止后台任务 ${task.id}？`, `停止背景任務 ${task.id}？`)}
        description={agent
          ? w("The subagent stops now. Work it already did stays, but it will not finish its report.", "子智能体会立即停止。已完成的工作会保留，但不会完成报告。", "子智慧體會立即停止。已完成的工作會保留，但不會完成報告。")
          : w("The command and every process it started are terminated. Output so far is kept.", "将终止该命令及其启动的所有进程。已产生的输出会保留。", "將終止該命令及其啟動的所有程序。已產生的輸出會保留。")}
        confirmLabel={w("Stop", "停止", "停止")}
        busy={stopping}
        error={error || undefined}
        onConfirm={() => void stop()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function noticeTasks(message: Message): TaskView[] {
  const tasks = message.metadata.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((task): task is TaskView => !!task && typeof task === "object" && typeof (task as TaskView).id === "string" && typeof (task as TaskView).status === "string");
}

/** A `task_notice` system message: one compact line per finished task, each opening it, before the AI's turn. */
export function TaskNoticeRow({ message }: { message: Message }) {
  const w = useWords();
  const tasks = useContext(TasksContext);
  const list = noticeTasks(message);
  return (
    <div role="group" aria-label={w("Background task results", "后台任务结果", "背景任務結果")} className="flex items-center gap-3">
      <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
      <ul className="flex min-w-0 max-w-[85%] flex-col items-center gap-0.5">
        {list.length ? list.map((task) => {
          const content = (
            <>
              <Icon name={task.status === "completed" ? "check" : task.status === "stopped" ? "info" : "warning"} size={14} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{noticeLine(task, w)}</span>
            </>
          );
          const line = "flex items-center gap-1.5 rounded-control px-1.5 py-0.5 text-center text-[12.5px] text-ink-2";
          return (
            <li key={task.id} className="min-w-0">
              {tasks ? (
                <button type="button" onClick={() => tasks.open(task.id)} className={`${line} transition-colors duration-100 hover:bg-hover hover:text-ink touch:min-h-11`}>{content}</button>
              ) : (
                <span className={line}>{content}</span>
              )}
            </li>
          );
        }) : <li className="text-[12.5px] text-ink-2">{message.content}</li>}
      </ul>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
    </div>
  );
}
