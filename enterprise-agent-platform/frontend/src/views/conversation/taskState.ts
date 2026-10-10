import { createContext } from "react";
import { intlLocale } from "../../i18n";
import type { Words } from "./work";

/** A personal AI background process or subagent (platform-api.md § Tasks); `id` is `bg-<n>`. */
export interface TaskView {
  id: string;
  kind: "process" | "agent";
  name: string | null;
  label: string;
  agent_type: "scout" | "task" | null;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted";
  reason: string;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  result_preview: string;
  created_by_message_id: number | null;
  created_by_tool_call_id: string | null;
  /** what a running agent is doing now */
  current: { tool: string; summary: string } | null;
  usage: { total_tokens: number } | null;
}

/** `GET /api/tasks/{id}/output`: one window of the process's logical output stream (Manager read). */
export interface TaskOutput {
  data: string;
  offset_start: number;
  next_offset: number;
  /** output before this offset was dropped by the retention cap */
  retained_from: number;
  eof: boolean;
}

export type TaskMap = Record<string, TaskView>;

export function taskNumber(id: string): number {
  const n = Number(id.replace(/^bg-/, ""));
  return Number.isFinite(n) ? n : 0;
}

export function isRunning(task: TaskView): boolean {
  return task.status === "running";
}

/** Merges one task update. A task that ended never returns to running, and a snapshot requested before the task's
 * latest stream update (`stale`) does not replace it unless it carries the end. */
export function mergeTask(current: TaskView | undefined, incoming: TaskView, stale: boolean): TaskView {
  if (!current) return incoming;
  if (!isRunning(current) && isRunning(incoming)) return current;
  if (stale && isRunning(current) === isRunning(incoming)) return current;
  return incoming;
}

/** Running first, then newest. */
export function sortTasks(tasks: Iterable<TaskView>): TaskView[] {
  return [...tasks].sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || taskNumber(b.id) - taskNumber(a.id));
}

/** What the conversation's work trace, notices and computer panel share (personal AI only). */
export interface TasksValue {
  byId: ReadonlyMap<string, TaskView>;
  /** tasks by the tool call that created them, oldest first */
  byToolCall: ReadonlyMap<string, TaskView[]>;
  /** running first, then newest */
  sorted: readonly TaskView[];
  loaded: boolean;
  error: string;
  reload: () => void;
  /** a process opens its output viewer, an agent its sheet */
  open: (id: string) => void;
}

export const TasksContext = createContext<TasksValue | null>(null);

export function tasksValue(tasks: TaskMap, loaded: boolean, error: string, reload: () => void, open: (id: string) => void): TasksValue {
  const byId = new Map(Object.entries(tasks));
  const byToolCall = new Map<string, TaskView[]>();
  for (const task of [...byId.values()].sort((a, b) => taskNumber(a.id) - taskNumber(b.id))) {
    if (!task.created_by_tool_call_id) continue;
    const list = byToolCall.get(task.created_by_tool_call_id);
    if (list) list.push(task);
    else byToolCall.set(task.created_by_tool_call_id, [task]);
  }
  return { byId, byToolCall, sorted: sortTasks(byId.values()), loaded, error, reload, open };
}

/** The Runtime's promotion result names the task: "Running in the background as bg-<n> …". */
const PROMOTED = /Running in the background as (bg-\d+)/;

export function promotedTaskId(output: string): string | null {
  return PROMOTED.exec(output)?.[1] ?? null;
}

/** The status a task row, chip or pill reads as. */
export function taskStatusLabel(task: Pick<TaskView, "status" | "reason">, w: Words): string {
  switch (task.status) {
    case "running":
      return w("Running", "运行中", "執行中");
    case "completed":
      return w("Completed", "已完成", "已完成");
    case "failed":
      return w("Failed", "失败", "失敗");
    case "stopped":
      return w("Stopped", "已停止", "已停止");
    case "interrupted":
      return task.reason === "system_restart" ? w("Interrupted by a restart", "因系统重启中断", "因系統重新啟動中斷") : w("Interrupted", "已中断", "已中斷");
  }
}

/** The ToolChips state glyph a task reads as (ring, check, warning mark). */
export const TASK_TOOL_STATE: Record<TaskView["status"], "running" | "done" | "error" | "cancelled"> = {
  running: "running", completed: "done", failed: "error", stopped: "cancelled", interrupted: "cancelled",
};

export function agentTypeLabel(type: TaskView["agent_type"], w: Words): string {
  return type === "scout" ? w("Research", "调研", "調研") : w("Worker", "执行", "執行");
}

/** The task's readable name: its given name, else its label (the command, or the subagent's assignment). */
export function taskTitle(task: TaskView): string {
  return task.name || task.label || task.id;
}

export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Elapsed time of a task until it ended, or until `now` while running; null without a parsable start. */
export function taskElapsed(task: TaskView, now: number): string | null {
  const start = Date.parse(task.started_at);
  if (Number.isNaN(start)) return null;
  const end = task.ended_at ? Date.parse(task.ended_at) : now;
  return elapsed((Number.isNaN(end) ? now : end) - start);
}

export function tokenCount(tokens: number, w: Words): string {
  const value = new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(Math.max(0, Math.round(tokens)));
  return w(`${value} tokens`, `${value} Token`, `${value} Token`);
}

/** One line of a `task_notice` row: 「后台任务完成：bg-12 pytest · 退出码 0」. */
export function noticeLine(task: TaskView, w: Words): string {
  const agent = task.kind === "agent";
  let lead: string;
  switch (task.status) {
    case "completed":
      lead = agent ? w("Subagent finished", "子智能体完成", "子智慧體完成") : w("Background task finished", "后台任务完成", "背景任務完成");
      break;
    case "failed":
      lead = agent ? w("Subagent failed", "子智能体失败", "子智慧體失敗") : w("Background task failed", "后台任务失败", "背景任務失敗");
      break;
    case "stopped":
      lead = agent ? w("Subagent stopped", "子智能体已停止", "子智慧體已停止") : w("Background task stopped", "后台任务已停止", "背景任務已停止");
      break;
    case "interrupted":
      lead = task.reason === "system_restart"
        ? w("Interrupted by a system restart", "后台任务因系统重启中断", "背景任務因系統重新啟動中斷")
        : w("Background task interrupted", "后台任务中断", "背景任務中斷");
      break;
    default:
      lead = w("Background task running", "后台任务运行中", "背景任務執行中");
  }
  const parts = [`${task.id} ${taskTitle(task)}`];
  if (task.exit_code !== null) parts.push(w(`exit code ${task.exit_code}`, `退出码 ${task.exit_code}`, `結束代碼 ${task.exit_code}`));
  return w(`${lead}: ${parts.join(" · ")}`, `${lead}：${parts.join(" · ")}`, `${lead}：${parts.join(" · ")}`);
}

/** Announced once when a task changes state; never for activity or output. */
export function stateAnnouncement(task: TaskView, w: Words): string {
  return isRunning(task)
    ? w(`${task.id} started`, `${task.id} 已开始`, `${task.id} 已開始`)
    : w(`${task.id} ${taskStatusLabel(task, w).toLowerCase()}`, `${task.id} ${taskStatusLabel(task, w)}`, `${task.id} ${taskStatusLabel(task, w)}`);
}
