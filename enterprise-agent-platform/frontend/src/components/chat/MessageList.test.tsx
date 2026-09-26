// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
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

  it("shows a real tool call as an open live record whose running row has no evidence control", () => {
    renderMessageList({
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "replying" },
        {
          source: "agent",
          stage: "tool",
          tool: "web",
          tool_call_id: "web-1",
          tool_status: "running",
        },
        { source: "agent", stage: "approval", detail: "Unrelated lifecycle row" },
      ],
    });

    const record = screen.getByRole("region", { name: "AI work" });
    expect(within(record).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Unrelated lifecycle row")).toBeNull();
    const row = within(record).getByRole("listitem");
    expect(row).toHaveTextContent("Web search");
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

  it("deduplicates finalized commentary and prefers the live version of a repeated stream identity", () => {
    const phase = "The documents are checked.";
    renderMessageList({
      run_id: "run-transition",
      state: "replying",
      activity: [
        { stage: "assistant.message", line: phase, detail: phase, sequence: 1 },
        { stage: "tool.completed", tool: "read_file", tool_call_id: "read-transition", tool_status: "completed", sequence: 2 },
      ],
      stream_messages: [
        { id: "phase-buffer", content: phase },
        { id: "answer-buffer", content: "Obsolete partial answer" },
      ],
      stream_message: { id: "answer-buffer", content: "Current final answer", active: true },
    });

    expect(screen.getAllByText(phase)).toHaveLength(1);
    expect(screen.getAllByText("Current final answer")).toHaveLength(1);
    expect(screen.queryByText("Obsolete partial answer")).toBeNull();
    expect(within(screen.getByRole("region", { name: "AI work" })).queryByText("Current final answer")).toBeNull();
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

  it("keeps the finished reply on screen until its persisted message arrives", () => {
    const activity: AgentStatus["activity"] = [
      { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-gap", tool_status: "completed", parameters: { command: "make report" }, result: "done" },
    ];
    const live: AgentStatus = {
      run_id: "run-gap",
      state: "replying",
      updated_at: 100,
      activity,
      stream_message: { id: "stream-gap", content: "Quarterly report is ready", updated_at: 100 },
    };
    const view = renderMessageList(live, [], "private");
    expect(screen.getByText("Quarterly report is ready")).toBeVisible();

    act(() => {
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: { mode: "private", scopeId: "1", status: { run_id: "", state: "idle", updated_at: 101 } },
      });
    });
    expect(screen.getByText("Quarterly report is ready")).toBeVisible();
    expect(screen.getAllByRole("region", { name: "AI work" })).toHaveLength(1);

    act(() => {
      view.store.dispatch({
        type: "SET_PRIVATE_MESSAGES",
        payload: [{
          id: 45,
          author_type: "agent",
          username: "Private Agent",
          content: "Quarterly report is ready",
          metadata: { agent_work: { run_id: "run-gap", state: "complete", activity } },
          created_at: 101,
        }],
      });
    });
    expect(screen.getAllByText("Quarterly report is ready")).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "AI work" })).toHaveLength(1);
  });

  it("keeps the finished reply above the next queued run until it is persisted", () => {
    const view = renderMessageList({
      run_id: "run-first",
      state: "replying",
      updated_at: 100,
      stream_message: { id: "stream-first", content: "First answer", updated_at: 100 },
    });
    act(() => {
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: { mode: "channel", scopeId: "1", status: { run_id: "run-second", state: "queued", updated_at: 101, queued_count: 1 } },
      });
    });
    expect(screen.getByText("First answer")).toBeVisible();
  });

  it("drops an unpersisted finished reply after the settle window", () => {
    vi.useFakeTimers();
    try {
      const view = renderMessageList({
        run_id: "run-lost",
        state: "replying",
        updated_at: 100,
        stream_message: { id: "stream-lost", content: "Never persisted", updated_at: 100 },
      });
      act(() => {
        view.store.dispatch({
          type: "SET_AGENT_STATUS",
          payload: { mode: "channel", scopeId: "1", status: { run_id: "", state: "idle", updated_at: 101 } },
        });
      });
      expect(screen.getByText("Never persisted")).toBeVisible();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByText("Never persisted")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("hides an obsolete streamed draft after a newer steering turn starts", () => {
    renderMessageList({
      state: "replying",
      stream_messages: [
        {
          id: "old-turn",
          content: "obsolete draft",
          turn_id: "run:1",
          turn_index: 1,
          active: false,
        },
      ],
      stream_message: {
        id: "new-turn",
        content: "consolidated answer",
        turn_id: "run:2",
        turn_index: 2,
        active: true,
      },
    });

    expect(screen.queryByText("obsolete draft")).toBeNull();
    expect(screen.getByText("consolidated answer")).toBeTruthy();
  });

  it("prefers the live draft when turn metadata is only partially available", () => {
    renderMessageList({
      state: "replying",
      stream_messages: [
        {
          id: "tagged-old-turn",
          content: "tagged obsolete draft",
          turn_id: "run:1",
          turn_index: 1,
          active: false,
        },
      ],
      stream_message: {
        id: "untagged-live-turn",
        content: "live consolidated answer",
        active: true,
      },
    });

    expect(screen.queryByText("tagged obsolete draft")).toBeNull();
    expect(screen.getByText("live consolidated answer")).toBeTruthy();
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
