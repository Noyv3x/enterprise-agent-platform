// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { sendMessage } from "../../data/chatActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { resetApiSession } from "../../lib/api";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus, AppState, Message } from "../../types";
import { MessageList } from "./MessageList";

function renderMessageList(
  status: AgentStatus,
  messages: Message[] = [],
  mode: "channel" | "private" = "channel",
) {
  const state: AppState = {
    ...initialAppState,
    user: {
      id: 1,
      username: "admin",
      display_name: "Administrator",
      role: "admin",
    },
    activeChannelId: 1,
    messages: mode === "channel" ? messages : [],
    privateMessages: mode === "private" ? messages : [],
    agentStatuses: {
      channels: mode === "channel" ? { "1": status } : {},
      private: mode === "private" ? status : null,
    },
  };
  const store = createStore(rootReducer, state);
  const view = render(
    <I18nProvider>
      <StoreContext.Provider value={store}>
        <MessageList mode={mode} scopeId="1" noChannel={false} forceBottomToken={0} />
      </StoreContext.Provider>
    </I18nProvider>,
  );
  return { ...view, store };
}

describe("MessageList Agent work records", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("uses the lightweight replying indicator when no tool was called", () => {
    renderMessageList({
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "queued" },
        { source: "platform", stage: "replying" },
      ],
    });

    expect(screen.getByText("Agent is replying to Administrator")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "AI work" })).toBeNull();
  });

  it("offers withdrawal only for the current user's persisted channel messages", () => {
    renderMessageList(
      { state: "idle" },
      [
        {
          id: 1,
          scope_type: "channel",
          scope_id: "1",
          author_type: "user",
          user_id: 1,
          username: "Administrator",
          content: "mine",
        },
        {
          id: 2,
          scope_type: "channel",
          scope_id: "1",
          author_type: "user",
          user_id: 2,
          username: "Alice",
          content: "theirs",
        },
        {
          id: 3,
          scope_type: "channel",
          scope_id: "1",
          author_type: "agent",
          user_id: null,
          username: "Agent",
          content: "answer",
        },
        {
          id: "tmp-4",
          scope_type: "channel",
          scope_id: "1",
          author_type: "user",
          user_id: 1,
          username: "Administrator",
          content: "sending",
          metadata: { local_pending: true },
        },
      ],
    );

    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(1);
  });

  it("keeps approval separate from work records when no tool was called", () => {
    renderMessageList({
      state: "approval",
      replying_to: { username: "Administrator" },
      activity: [{ source: "agent", stage: "approval", detail: "Run a command" }],
      approval: {
        approval_id: "approval-1",
        description: "Run a command",
        choices: ["once", "deny"],
      },
      active_input_group: {
        id: "agent:job-1",
        message_count: 2,
      },
    });

    expect(screen.getByText("Waiting for Administrator to approve access")).toBeTruthy();
    expect(screen.getByText("Access approval")).toBeTruthy();
    expect(screen.queryByText(/combining 2 messages/)).toBeNull();
    expect(screen.queryByRole("region", { name: "AI work" })).toBeNull();
  });

  it("shows a normal error message instead of an empty work record", () => {
    renderMessageList({
      state: "error",
      last_error: "Runtime unavailable",
      activity: [{ source: "platform", stage: "error", detail: "Runtime unavailable" }],
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Agent reply failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
    expect(screen.queryByRole("region", { name: "AI work" })).toBeNull();
  });

  it.each([
    { tool: "web", stage: "tool", label: "Web search" },
    { tool: "browser", stage: "tool.started", label: "Browser" },
  ])("shows running $tool work as an open live record without an evidence control", ({ tool, stage, label }) => {
    renderMessageList({
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "replying" },
        {
          source: "agent",
          stage,
          tool,
          tool_call_id: `${tool}-1`,
          tool_status: "running",
        },
        { source: "agent", stage: "approval", detail: "Unrelated lifecycle row" },
      ],
    });

    const record = screen.getByRole("region", { name: "AI work" });
    expect(within(record).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "true");
    expect(within(record).getAllByRole("button")[0]).toHaveAccessibleDescription("Agent is replying to Administrator");
    expect(screen.queryByText("Unrelated lifecycle row")).toBeNull();
    const row = within(record).getByRole("listitem");
    expect(row).toHaveTextContent(label);
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("shows finalized phase prose only once in the active compact timeline", () => {
    const phase = "The first scan completed; validation is starting.";
    renderMessageList({
      run_id: "run-phase",
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        {
          source: "agent",
          stage: "assistant.message",
          line: phase,
          detail: phase,
          sequence: 1,
        },
        {
          source: "agent",
          stage: "tool",
          tool: "search_files",
          tool_call_id: "search-phase",
          tool_status: "running",
          sequence: 2,
        },
      ],
      stream_messages: [],
      stream_message: null,
    });

    expect(screen.getAllByText(phase)).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "AI work" })).not.toBeNull();
  });


  it("keeps a folded live record folded and above the answer when the final response starts streaming", () => {
    const initialStatus: AgentStatus = {
      run_id: "run-streaming",
      state: "replying",
      updated_at: 100,
      replying_to: { username: "Administrator" },
      activity: [
        {
          source: "agent",
          stage: "tool",
          tool: "web",
          tool_call_id: "web-1",
          tool_status: "completed",
        },
      ],
    };
    const view = renderMessageList(initialStatus);
    const toggle = () => within(screen.getByRole("region", { name: "AI work" })).getAllByRole("button")[0]!;
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    act(() => {
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: {
          mode: "channel",
          scopeId: "1",
          status: {
            ...initialStatus,
            updated_at: 101,
            stream_message: {
              id: "stream-answer",
              content: "Final answer has started",
              updated_at: 101,
            },
          },
        },
      });
    });

    const workRecord = screen.getByRole("region", { name: "AI work" });
    const finalAnswer = screen.getByText("Final answer has started");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(
      workRecord.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("replaces the open live record with a collapsed persisted record when the run settles", () => {
    const activity: AgentStatus["activity"] = [
      { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-settle", tool_status: "completed", parameters: { command: "make report" }, result: "done" },
    ];
    const view = renderMessageList({ run_id: "run-settle", state: "replying", activity });
    expect(within(screen.getByRole("region", { name: "AI work" })).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "true");

    act(() => {
      view.store.dispatch({
        type: "SET_MESSAGES",
        payload: [{
          id: 43,
          author_type: "agent",
          username: "Agent",
          content: "Report ready",
          metadata: { agent_work: { run_id: "run-settle", state: "complete", activity } },
          created_at: 101,
        }],
      });
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: { mode: "channel", scopeId: "1", status: { run_id: "run-settle", state: "idle" } },
      });
    });

    const records = screen.getAllByRole("region", { name: "AI work" });
    expect(records).toHaveLength(1);
    expect(within(records[0]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(records[0]!).queryByRole("list")).toBeNull();
    expect(screen.getByText("Report ready")).toBeVisible();
  });

  it("renders the current stream alongside approval and clears it when Platform withdraws it", () => {
    const status: AgentStatus = {
      run_id: "run-approval-stream",
      state: "approval",
      updated_at: 100,
      stream_message: { id: "reply", content: "Checking the deployment", active: true },
      approval: { approval_id: "approval-stream", description: "Deploy the service", choices: ["once", "deny"] },
      activity: [{ stage: "tool", tool: "terminal", tool_call_id: "deploy", tool_status: "running", parameters: { command: "deploy service" } }],
    };
    const view = renderMessageList(status);
    expect(screen.getByText("Checking the deployment")).toBeVisible();
    expect(screen.getByText("Access approval")).toBeVisible();
    expect(screen.getByRole("region", { name: "AI work" })).toBeVisible();
    act(() => view.store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "channel", scopeId: "1", status: { ...status, updated_at: 101, stream_message: { id: "reply", content: "Deployment is authorized", active: true } } },
    }));
    expect(screen.queryByText("Checking the deployment")).toBeNull();
    expect(screen.getByText("Deployment is authorized")).toBeVisible();
    act(() => view.store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "channel", scopeId: "1", status: { state: "idle", updated_at: 102 } },
    }));
    expect(screen.queryByText("Deployment is authorized")).toBeNull();
    expect(screen.queryByText("Access approval")).toBeNull();
    act(() => view.store.dispatch({
      type: "SET_MESSAGES",
      payload: [{ id: 46, author_type: "agent", username: "Agent", content: "Deployment completed", metadata: { agent_work: { run_id: status.run_id, state: "complete", activity: [{ ...status.activity![0], tool_status: "completed" }] } } }],
    }));
    expect(screen.getByText("Deployment completed")).toBeVisible();
    expect(screen.getAllByRole("region", { name: "AI work" })).toHaveLength(1);
  });


  it.each([
    { order: "in one update", steps: ["both"] },
    { order: "status before message", steps: ["status", "message"] },
    { order: "message before status", steps: ["message", "status"] },
  ])("hands focus inside the live record to the persisted record's header ($order)", ({ steps }) => {
    const activity: AgentStatus["activity"] = [
      { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-focus", tool_status: "completed", parameters: { command: "make report" }, result: "done" },
    ];
    const view = renderMessageList({ run_id: "run-focus", state: "replying", activity });
    const liveRow = within(screen.getByRole("region", { name: "AI work" })).getAllByRole("listitem")[0]!;
    act(() => within(liveRow).getByRole("button").focus());

    const persist = () => view.store.dispatch({
      type: "SET_MESSAGES",
      payload: [{
        id: 44,
        author_type: "agent",
        username: "Agent",
        content: "Report ready",
        metadata: { agent_work: { run_id: "run-focus", state: "complete", activity } },
        created_at: 101,
      }],
    });
    const settle = () => view.store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "channel", scopeId: "1", status: { run_id: "run-focus", state: "idle" } },
    });
    for (const step of steps) {
      act(() => {
        if (step !== "status") persist();
        if (step !== "message") settle();
      });
    }

    const record = screen.getByRole("region", { name: "AI work" });
    expect(within(record).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(record).getByRole("button")).toHaveFocus();
  });

  it("leaves focus the user placed outside the live record alone when the run settles", () => {
    const activity: AgentStatus["activity"] = [
      { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-outside", tool_status: "completed", parameters: { command: "make report" }, result: "done" },
    ];
    const view = renderMessageList({ run_id: "run-outside", state: "replying", activity });
    const log = screen.getByRole("log");
    act(() => log.focus());

    act(() => {
      view.store.dispatch({
        type: "SET_MESSAGES",
        payload: [{
          id: 45,
          author_type: "agent",
          username: "Agent",
          content: "Report ready",
          metadata: { agent_work: { run_id: "run-outside", state: "complete", activity } },
          created_at: 101,
        }],
      });
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: { mode: "channel", scopeId: "1", status: { run_id: "run-outside", state: "idle" } },
      });
    });

    expect(log).toHaveFocus();
  });

  it("keeps persisted Agent updates inside work while the final answer stays separate", () => {
    renderMessageList(
      { state: "idle" },
      [
        {
          id: 42,
          author_type: "agent",
          username: "Agent",
          content: "Persisted final answer",
          metadata: {
            agent_work: {
              run_id: "run-complete",
              state: "complete",
              activity: [
                {
                  stage: "tool.completed",
                  tool: "search_files",
                  tool_call_id: "search-1",
                  tool_status: "completed",
                  detail: "frontend work-record tests",
                },
                {
                  source: "agent",
                  stage: "assistant.message",
                  line: "I checked the focused tests.",
                  detail: "I checked the focused tests.\n\nThey cover the persisted update.",
                },
              ],
            },
          },
          created_at: 100,
        },
      ],
    );

    const workRecord = screen.queryByRole("region", { name: "AI work" });
    const finalAnswer = screen.getByText("Persisted final answer");
    expect(workRecord).not.toBeNull();
    if (!workRecord) throw new Error("Expected persisted work record");
    const disclosure = within(workRecord).getByRole("button");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(workRecord).not.toContainElement(finalAnswer);
    expect(
      workRecord.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(disclosure!);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const updateRow = within(workRecord).getAllByRole("listitem").find((item) => within(item).queryByText("AI update"));
    if (!updateRow) throw new Error("Expected persisted Agent update row");
    const updateDisclosure = within(updateRow).getByRole("button");
    expect(updateDisclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(updateDisclosure!);
    expect(updateDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(within(updateRow).getByRole("group")).toHaveTextContent(
      "I checked the focused tests. They cover the persisted update.",
    );
    expect(screen.getByText("Persisted final answer")).toBeVisible();
  });

  it("shows no author names in Personal AI, where both sides are implied", () => {
    renderMessageList(
      { state: "idle" },
      [
        {
          id: 7,
          scope_type: "private",
          scope_id: "1",
          author_type: "user",
          user_id: 1,
          username: "Administrator",
          content: "hello",
          created_at: 100,
        },
        {
          id: 8,
          scope_type: "private",
          scope_id: "1",
          author_type: "agent",
          user_id: null,
          username: "Private Agent",
          content: "here is the answer",
          created_at: 101,
        },
      ],
      "private",
    );

    expect(screen.getByText("hello")).toBeVisible();
    expect(screen.getByText("here is the answer")).toBeVisible();
    expect(screen.queryByText("Administrator")).toBeNull();
    expect(screen.queryByText("Personal AI")).toBeNull();
  });

  it("shows one compact status for a joined rapid-message group", () => {
    renderMessageList({
      state: "replying",
      replying_to: { username: "Administrator" },
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 3,
        message_ids: [11, 12, 13],
      },
    });

    expect(screen.getByText("Agent is combining 3 messages into one reply")).toBeTruthy();
    expect(screen.queryByText("Agent is replying to Administrator")).toBeNull();
  });

  it("announces a newly persisted member message once but not hydration or older history", () => {
    const initial: Message = { id: 20, author_type: "user", user_id: 2, username: "Alice", content: "Existing conversation" };
    const incoming: Message = { id: 21, author_type: "user", user_id: 2, username: "Alice", content: "New member message" };
    const view = renderMessageList({ state: "idle" }, [initial]);
    expect(screen.queryByText("1 new message")).toBeNull();
    act(() => view.store.dispatch({ type: "SET_MESSAGES", payload: [initial, incoming] }));
    const announcement = screen.getByText("1 new message");
    expect(announcement.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    act(() => view.store.dispatch({ type: "SET_MESSAGES", payload: [initial, incoming] }));
    expect(screen.queryByText("1 new message")).toBeNull();
    act(() => {
      view.store.dispatch({ type: "SET_MESSAGE_HISTORY", payload: {
        key: "channel:1", history: { nextBeforeId: null, hasMore: false, loading: false, error: "", prependVersion: 1 },
      } });
      view.store.dispatch({ type: "SET_MESSAGES", payload: [
        { ...initial, id: 19, content: "Older member message" }, initial, incoming,
      ] });
    });
    expect(screen.queryByText("1 new message")).toBeNull();
    expect(screen.getByText("Older member message")).toBeVisible();
  });

  it("updates the jump action's unread count without losing keyboard focus, then returns to latest", () => {
    const earlier: Message = { id: 40, author_type: "user", user_id: 2, username: "Alice", content: "Earlier message" };
    const view = renderMessageList({ state: "idle" }, [earlier]);
    const log = screen.getByRole("log", { name: "Public channel messages" });
    // The setup stub never fires ResizeObserver, so the viewport size must stay at its mount value.
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 300, writable: true },
      scrollTo: { configurable: true, value: ({ top }: ScrollToOptions) => { log.scrollTop = Number(top); } },
    });
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    fireEvent.scroll(log);
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    jump.focus();

    act(() => view.store.dispatch({ type: "SET_MESSAGES", payload: [earlier, { ...earlier, id: 41, content: "Newer message" }] }));
    expect(screen.getByRole("button", { name: "1 new message" })).toHaveFocus();

    fireEvent.click(jump);
    expect(log.scrollTop).toBe(1_000);
    expect(screen.queryByRole("button", { name: /Jump to latest|new message/ })).toBeNull();
  });
});

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function response(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function pendingMessage(mode: "channel" | "private", content: string): Message {
  return {
    id: `tmp-${content}`,
    scope_type: mode,
    scope_id: "1",
    author_type: "user",
    user_id: 1,
    username: "Administrator",
    content,
    metadata: { local_pending: true },
  };
}

describe("MessageList reply wait for a just-sent message", () => {
  const wait = "Agent is preparing a reply";
  const channelWait = "Agent is preparing a reply to Administrator";

  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    resetApiSession();
    vi.unstubAllGlobals();
  });

  it("shows the Agent's wait as soon as a Personal AI message is sent and keeps it in place once the run is queued", async () => {
    let respond!: (value: FakeResponse) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<FakeResponse>((resolve) => { respond = resolve; })));
    const view = renderMessageList({ state: "idle" }, [], "private");

    let sending!: Promise<boolean | null>;
    act(() => { sending = sendMessage(view.store, "private", "1", "Summarize the report", []); });
    const pendingWait = screen.getByText(wait);
    expect(screen.getByText("Summarize the report")).toBeVisible();

    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    await act(async () => {
      respond(response(200, {
        user_message: {
          id: 31,
          scope_type: "private",
          scope_id: "1",
          author_type: "user",
          user_id: 1,
          username: "Administrator",
          content: "Summarize the report",
          created_at: 100,
        },
        agent_status: { run_id: "run-1", state: "queued", replying_to: { username: "Administrator" }, started_at: 100, updated_at: 100 },
      }));
      await expect(sending).resolves.toBe(true);
    });

    expect(view.store.getState().pendingMessages).toEqual([]);
    expect(screen.getByText(wait)).toBe(pendingWait);
  });

  it("lets the wait stand in for the last failure until the send itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(503, { error: "temporarily unavailable" })));
    const view = renderMessageList({ state: "error", last_error: "Runtime unavailable" }, [], "private");
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");

    let sending!: Promise<boolean | null>;
    act(() => { sending = sendMessage(view.store, "private", "1", "Try again", []); });
    expect(screen.getByText(wait)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => { await expect(sending).resolves.toBe(false); });
    expect(screen.queryByText("Try again")).toBeNull();
    expect(screen.queryByText(wait)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
  });

  it("leaves an Agent that is already working to its own status", () => {
    renderMessageList(
      { state: "replying", replying_to: { username: "Administrator" } },
      [pendingMessage("private", "One more thing")],
      "private",
    );

    expect(screen.getByText("Agent is replying")).toBeVisible();
    expect(screen.queryByText(wait)).toBeNull();
  });

  it.each([
    { content: "@agent summarize the thread", calls: true },
    { content: "Can @Main Agent check this?", calls: true },
    { content: "Lunch at noon", calls: false },
    { content: "Mail ops@agent.example", calls: false },
    { content: "Ask @agents later", calls: false },
    { content: "请@agent 看看", calls: false },
  ])("waits in a channel only when the Platform will call the Agent: $content", ({ content, calls }) => {
    renderMessageList({ state: "idle" }, [pendingMessage("channel", content)]);

    expect(Boolean(screen.queryByText(channelWait))).toBe(calls);
  });
});
