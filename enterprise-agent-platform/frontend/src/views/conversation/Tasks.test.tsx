// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../components/ui/beautiful/controls";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { Conversation } from "../Conversation";
import type { TaskView } from "./taskState";
import type { Message } from "./types";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../api", () => api);

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {}
}

let seq = 0;
function emit(event: Record<string, unknown> & { type: string }) {
  act(() => {
    FakeEventSource.instances[0].dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq: ++seq, ...event }), lastEventId: String(seq) }));
  });
}

function task(id: string, patch: Partial<TaskView> = {}): TaskView {
  return {
    id, kind: "process", name: null, label: "pytest -q", agent_type: null, status: "running", reason: "", exit_code: null,
    started_at: "2026-10-10T08:00:00Z", ended_at: null, result_preview: "", created_by_message_id: 1, created_by_tool_call_id: null,
    current: null, usage: null, ...patch,
  };
}

const agent = (id: string, patch: Partial<TaskView> = {}) => task(id, { kind: "agent", agent_type: "scout", label: "Survey the API docs", name: "ApiSurvey", created_by_tool_call_id: "t1", ...patch });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Handler = (body: Record<string, unknown>, options: RequestInit) => unknown;
let routes: Record<string, Handler> = {};
let snapshot: TaskView[] = [];

function calls(method: string, path: string) {
  return api.request.mock.calls.filter(([called, options]) => called === path && ((options as RequestInit | undefined)?.method ?? "GET") === method);
}

async function mount(messages: Message[] = [], locale = "en") {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    const handler = routes[`${method} ${path}`];
    if (handler) return handler(typeof options.body === "string" ? JSON.parse(options.body) : {}, options);
    if (path.startsWith("/api/conversations/private/messages")) return { messages, next_before_id: null, last_seq: 0, compaction: null };
    if (path === "/api/tasks") return { tasks: snapshot };
    if (path === "/api/browser") return { tabs: [], lease: null };
    if (path.startsWith("/api/workspace/files")) return { files: [] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const aside = document.createElement("div");
  document.body.append(aside);
  render(
    <I18nProvider>
      <ShellContext.Provider value={{ narrow: false, openNavigation: () => undefined, asideSlot: aside }}>
        <Conversation scope="private" />
      </ShellContext.Provider>
    </I18nProvider>,
  );
  const panel = await screen.findByRole("complementary", { name: locale === "en" ? "Computer" : "电脑" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return panel;
}

const text = (value: string) => [{ type: "text", text: value }];

function reply(id: number, items: Record<string, unknown>[]): Message {
  return {
    id, role: "assistant", content: `Reply ${id}.`, created_at: "2026-10-10T08:00:30Z", attachments: [],
    metadata: { status: "completed", work: { v: 1, started_at: "2026-10-10T08:00:00Z", ended_at: "2026-10-10T08:00:30Z", truncated: false, items } },
  };
}

function notice(id: number, tasks: TaskView[], extra: Record<string, unknown> = {}): Message {
  return { id, role: "system", content: "Background task results", created_at: "2026-10-10T08:01:00Z", attachments: [], metadata: { kind: "task_notice", task_ids: tasks.map((item) => item.id), tasks, ...extra } };
}

const politeTaskStatus = () => screen.getByRole("status", { name: "Background tasks" });

describe("personal AI background tasks", () => {
  beforeEach(() => {
    seq = 0;
    routes = {};
    snapshot = [];
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse("2026-10-10T08:00:41Z") });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("nests subagent rows under their task row and updates them from SSE", async () => {
    await mount();
    emit({ type: "tool_start", tool_call_id: "t1", name: "task", args: { agent: "scout", tasks: [{ name: "ApiSurvey", task: "Survey the API docs" }, { name: "Fixer", task: "Fix it" }] } });
    emit({ type: "tool_end", tool_call_id: "t1", is_error: false, content_preview: text("Started bg-3, bg-4"), details: null });
    const live = screen.getByRole("article", { name: "Reply in progress" });
    expect(within(live).getByText("Delegate")).toBeVisible();

    emit({ type: "task", task: agent("bg-3", { current: { tool: "read", summary: "docs/api.md" }, usage: { total_tokens: 1200 } }) });
    emit({ type: "task", task: agent("bg-4", { name: "Fixer", agent_type: "task", label: "Fix it" }) });
    const survey = within(live).getByRole("button", { name: /^ApiSurvey/ });
    expect(survey).toHaveTextContent("Research");
    expect(survey).toHaveTextContent("Read docs/api.md");
    expect(survey).toHaveTextContent(/bg-3 · 4\ds · 1\.2K tokens/);
    expect(survey).toHaveTextContent("Running");
    expect(within(live).getByRole("button", { name: /^Fixer/ })).toHaveTextContent("Worker");

    // Activity and state change in place; only the state change is announced.
    emit({ type: "task", task: agent("bg-3", { current: { tool: "grep", summary: "auth" }, usage: { total_tokens: 3400 } }) });
    expect(survey).toHaveTextContent("Search files auth");
    expect(politeTaskStatus()).toHaveTextContent("bg-4 started");
    emit({ type: "task", task: agent("bg-3", { status: "completed", ended_at: "2026-10-10T08:00:52Z", result_preview: "Found 3 endpoints.\nDetails", usage: { total_tokens: 5100 } }) });
    expect(survey).toHaveTextContent("Found 3 endpoints.");
    expect(survey).toHaveTextContent("bg-3 · 52s · 5.1K tokens");
    expect(politeTaskStatus()).toHaveTextContent("bg-3 completed");
    // A late or replayed running update never revives a finished task.
    emit({ type: "task", task: agent("bg-3", { current: { tool: "read", summary: "old" } }) });
    expect(survey).toHaveTextContent("Found 3 endpoints.");
  });

  it("keeps an SSE update when the task snapshot it raced is older", async () => {
    const list = deferred<{ tasks: TaskView[] }>();
    routes["GET /api/tasks"] = () => list.promise;
    const panel = await mount();
    emit({ type: "task", task: task("bg-5", { status: "completed", exit_code: 0, ended_at: "2026-10-10T08:00:20Z" }) });
    await act(async () => list.resolve({ tasks: [task("bg-5"), task("bg-6", { label: "npm run dev", name: "web" })] }));
    const rows = within(panel).getByRole("list", { name: "Background tasks" });
    expect(within(rows).getByRole("button", { name: /pytest -q/ })).toHaveTextContent("Completed");
    expect(within(rows).getByRole("button", { name: /^web/ })).toHaveTextContent("Running");
    // The snapshot is the starting point, not news.
    expect(politeTaskStatus()).toHaveTextContent("");
  });

  it("opens the subagent sheet with its work trace and report, and stops it after confirmation", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    snapshot = [agent("bg-3", { current: { tool: "read", summary: "docs/api.md" } })];
    let detail = { task: snapshot[0], work: { v: 1, started_at: "2026-10-10T08:00:00Z", ended_at: null, truncated: false, items: [
      { type: "tool", id: "c1", name: "read", args: { path: "docs/api.md" }, status: "done", output: "# API", started_at: "2026-10-10T08:00:01Z", ended_at: "2026-10-10T08:00:02Z" },
      { type: "tool", id: "c2", name: "grep", args: { pattern: "auth" }, status: "cancelled", output: "", started_at: "2026-10-10T08:00:03Z", ended_at: null },
    ] }, result: "" };
    routes["GET /api/tasks/bg-3"] = () => detail;
    routes["POST /api/tasks/bg-3/stop"] = () => ({ task: agent("bg-3", { status: "stopped", reason: "user", ended_at: "2026-10-10T08:00:50Z" }) });
    await mount([reply(2, [{ type: "tool", id: "t1", name: "task", args: { tasks: [{ name: "ApiSurvey", task: "Survey the API docs" }] }, status: "done", output: "Started bg-3", started_at: "2026-10-10T08:00:00Z", ended_at: "2026-10-10T08:00:01Z" }])]);

    const article = screen.getByRole("article", { name: "Agent reply" });
    await user.click(await within(article).findByRole("button", { name: /^ApiSurvey/ }));
    const sheet = await screen.findByRole("dialog", { name: "bg-3 · ApiSurvey" });
    expect(within(sheet).getByText("Survey the API docs")).toBeVisible();
    expect(await within(sheet).findByText("docs/api.md")).toBeVisible();
    // The running child step keeps its ring, and the steps are not the conversation's (no View in computer).
    expect(within(sheet).getAllByText("Running").length).toBeGreaterThan(1);
    expect(within(sheet).queryByRole("button", { name: "View in computer" })).not.toBeInTheDocument();
    expect(within(sheet).getByText("The report appears here when the subagent finishes.")).toBeVisible();

    // Each stream update refreshes the sheet; the finished report renders as Markdown.
    detail = { ...detail, task: agent("bg-3", { status: "completed", ended_at: "2026-10-10T08:00:45Z" }), result: "## Findings\n\n- **Three** endpoints" };
    emit({ type: "task", task: detail.task });
    expect(await within(sheet).findByRole("heading", { name: "Findings" })).toBeVisible();
    expect(within(sheet).getByText("Three").tagName).toBe("STRONG");
    expect(within(sheet).queryByRole("button", { name: "Stop subagent" })).not.toBeInTheDocument();
    expect(calls("POST", "/api/tasks/bg-3/stop")).toHaveLength(0);
  });

  it("asks before stopping a subagent and keeps it running when the stop is rejected", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    snapshot = [agent("bg-3")];
    routes["GET /api/tasks/bg-3"] = () => ({ task: snapshot[0], work: null });
    let attempt = 0;
    routes["POST /api/tasks/bg-3/stop"] = () => {
      attempt += 1;
      if (attempt === 1) throw new Error("termination could not be confirmed");
      return { task: agent("bg-3", { status: "stopped", reason: "user", ended_at: "2026-10-10T08:00:50Z" }) };
    };
    const panel = await mount();
    await user.click(within(panel).getByRole("button", { name: /^ApiSurvey/ }));
    const sheet = await screen.findByRole("dialog", { name: "bg-3 · ApiSurvey" });
    expect(await within(sheet).findByText("No steps yet")).toBeVisible();

    await user.click(within(sheet).getByRole("button", { name: "Stop subagent" }));
    const confirm = screen.getByRole("alertdialog", { name: "Stop bg-3?" });
    expect(calls("POST", "/api/tasks/bg-3/stop")).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Stop" }));
    expect(await within(confirm).findByText("termination could not be confirmed")).toBeVisible();
    expect(within(sheet).getAllByText("Running").length).toBeGreaterThan(0);

    await user.click(within(confirm).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(within(sheet).getByText("Stopped")).toBeVisible();
    expect(calls("POST", "/api/tasks/bg-3/stop")).toHaveLength(2);
  });

  it("shows a live background chip on a promoted bash row, live and after reload", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    routes["GET /api/tasks/bg-7/output?offset=-1"] = () => ({ data: "", offset_start: 0, next_offset: 0, retained_from: 0, eof: true });
    await mount([reply(2, [{ type: "tool", id: "b0", name: "bash", args: { command: "make docs" }, status: "done", output: "Running in the background as bg-9 (make docs).", started_at: "2026-10-10T08:00:00Z", ended_at: "2026-10-10T08:01:00Z" }])]);
    // Reloaded without `background`: the promotion result names the task.
    const persisted = screen.getByRole("article", { name: "Agent reply" });
    await user.click(within(persisted).getByRole("button", { name: /^Worked for/ }));
    expect(within(persisted).getByRole("button", { name: "Background · bg-9, Running" })).toBeVisible();

    emit({ type: "tool_start", tool_call_id: "b1", name: "bash", args: { command: "pytest -q" } });
    emit({ type: "tool_end", tool_call_id: "b1", is_error: false, content_preview: text("Started."), details: { background: { task_id: "bg-7", process_id: "proc_1" } } });
    const live = screen.getByRole("article", { name: "Reply in progress" });
    expect(within(live).getByRole("button", { name: "Background · bg-7, Running" })).toBeVisible();
    emit({ type: "task", task: task("bg-7", { created_by_tool_call_id: "b1" }) });
    emit({ type: "task", task: task("bg-7", { created_by_tool_call_id: "b1", status: "failed", exit_code: 1, ended_at: "2026-10-10T08:00:40Z" }) });
    const chip = within(live).getByRole("button", { name: "Background · bg-7, Failed" });
    await user.click(chip);
    expect(await screen.findByRole("dialog", { name: "bg-7 · pytest -q" })).toBeVisible();
  });

  it("renders task notices as status rows and hides skipped ones", async () => {
    const done = task("bg-12", { name: "pytest", status: "completed", exit_code: 0, ended_at: "2026-10-10T08:00:59Z" });
    const lost = task("bg-13", { name: "web", status: "interrupted", reason: "system_restart", ended_at: "2026-10-10T08:00:59Z" });
    const skipped = task("bg-14", { name: "lint", status: "completed", exit_code: 0 });
    await mount([notice(5, [done]), notice(6, [skipped], { skipped: true }), notice(7, [lost])], "zh-CN");
    const rows = screen.getAllByRole("group", { name: "后台任务结果" });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("button", { name: "后台任务完成：bg-12 pytest · 退出码 0" })).toBeVisible();
    expect(within(rows[1]).getByRole("button", { name: "后台任务因系统重启中断：bg-13 web" })).toBeVisible();
    expect(screen.queryByText(/bg-14/)).not.toBeInTheDocument();

    // A notice flipped to skipped while shown disappears.
    emit({ type: "message", message: notice(7, [lost], { skipped: true }) });
    expect(screen.getAllByRole("group", { name: "后台任务结果" })).toHaveLength(1);
  });

  it("lists tasks in the computer panel, long-polls a process's output while open and stops it after confirmation", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    snapshot = [
      task("bg-2", { label: "make", status: "completed", exit_code: 0, ended_at: "2026-10-10T08:00:05Z" }),
      task("bg-5", { label: "npm run dev", name: "web" }),
      agent("bg-4", { status: "failed", ended_at: "2026-10-10T08:00:30Z" }),
    ];
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const polls: string[] = [];
    let signal: AbortSignal | undefined;
    const output = (path: string) => (_body: Record<string, unknown>, options: RequestInit) => {
      polls.push(path);
      signal = options.signal ?? undefined;
      if (path.endsWith("offset=-1")) return { data: "listening on :5173\n", offset_start: 9000, next_offset: 9019, retained_from: 0, eof: false };
      if (path.endsWith("offset=9019&wait_ms=25000")) return second.promise;
      return third.promise;
    };
    routes["GET /api/tasks/bg-5/output?offset=-1"] = output("offset=-1");
    routes["GET /api/tasks/bg-5/output?offset=9019&wait_ms=25000"] = output("offset=9019&wait_ms=25000");
    routes["GET /api/tasks/bg-5/output?offset=9040&wait_ms=25000"] = output("offset=9040&wait_ms=25000");
    routes["POST /api/tasks/bg-5/stop"] = () => ({ task: task("bg-5", { label: "npm run dev", name: "web", status: "stopped", reason: "user", ended_at: "2026-10-10T08:00:50Z" }) });
    const panel = await mount();

    const list = within(panel).getByRole("list", { name: "Background tasks" });
    const rows = within(list).getAllByRole("button");
    // Running first, then newest.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("web"), expect.stringContaining("ApiSurvey"), expect.stringContaining("make"),
    ]);
    expect(rows[0]).not.toHaveAttribute("aria-expanded");
    expect(within(panel).getByRole("heading", { name: "Background tasks · 1 running" })).toBeVisible();

    await user.click(rows[0]);
    const viewer = await screen.findByRole("dialog", { name: "bg-5 · web" });
    const log = within(viewer).getByRole("log", { name: "Task output" });
    expect(log).toHaveAttribute("aria-live", "off");
    expect(await within(log).findByText(/listening on :5173/)).toBeVisible();
    expect(log).toHaveTextContent("$ npm run dev");
    expect(log).toHaveTextContent("showing the latest output");
    await waitFor(() => expect(polls).toContain("offset=9019&wait_ms=25000"));

    await act(async () => second.resolve({ data: "GET / 200\n", offset_start: 9019, next_offset: 9040, retained_from: 0, eof: false }));
    expect(log).toHaveTextContent(/listening on :5173\s*GET \/ 200/);
    await waitFor(() => expect(polls).toContain("offset=9040&wait_ms=25000"));

    await user.click(within(viewer).getByRole("button", { name: "Stop task" }));
    const confirm = screen.getByRole("alertdialog", { name: "Stop bg-5?" });
    expect(within(confirm).getByText("The command and every process it started are terminated. Output so far is kept.")).toBeVisible();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(calls("POST", "/api/tasks/bg-5/stop")).toHaveLength(0);

    await user.click(within(viewer).getByRole("button", { name: "Stop task" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(viewer).getByText("Stopped")).toBeVisible());
    expect(within(viewer).queryByRole("button", { name: "Stop task" })).not.toBeInTheDocument();

    // Closing the viewer ends its long poll.
    await user.click(within(viewer).getByRole("button", { name: "Close output" }));
    expect(screen.queryByRole("dialog", { name: "bg-5 · web" })).not.toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    const count = polls.length;
    await act(async () => third.resolve({ data: "late\n", offset_start: 9040, next_offset: 9045, retained_from: 0, eof: true }));
    expect(polls).toHaveLength(count);
  });

  it("shows a load failure with retry and guides an empty list", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let fail = true;
    routes["GET /api/tasks"] = () => {
      if (fail) throw new Error("Platform unavailable");
      return { tasks: [] };
    };
    const panel = await mount();
    expect(await within(panel).findByText("Background tasks could not be loaded")).toBeVisible();
    fail = false;
    await user.click(within(panel).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByText("Commands the agent keeps running in the background and the subagents it delegates to appear here.")).toBeVisible();
  });
});
