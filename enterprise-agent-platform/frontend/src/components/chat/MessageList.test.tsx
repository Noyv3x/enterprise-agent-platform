// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(screen.queryByRole("region", { name: "View AI work" })).toBeNull();
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
    expect(screen.queryByRole("region", { name: "View AI work" })).toBeNull();
  });

  it("shows a normal error message instead of an empty work record", () => {
    renderMessageList({
      state: "error",
      last_error: "Runtime unavailable",
      activity: [{ source: "platform", stage: "error", detail: "Runtime unavailable" }],
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Agent reply failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
    expect(screen.queryByRole("region", { name: "View AI work" })).toBeNull();
  });

  it("shows a real tool call as a compact non-interactive row", () => {
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

    expect(screen.queryByRole("region", { name: "View AI work" })).not.toBeNull();
    expect(screen.getByText("Web search")).toBeVisible();
    expect(screen.getByText("Web search · Running")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.queryByText("Unrelated lifecycle row")).toBeNull();
    expect(within(screen.getByRole("region", { name: "View AI work" })).getAllByRole("listitem")).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "View AI work" })).queryByRole("button")).toBeNull();
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
    expect(screen.queryByRole("region", { name: "View AI work" })).not.toBeNull();
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
    expect(within(screen.getByRole("region", { name: "View AI work" })).queryByText("Current final answer")).toBeNull();
  });

  it("keeps active work non-interactive when the final response starts streaming", () => {
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

    expect(screen.queryByRole("region", { name: "View AI work" })).not.toBeNull();
    expect(within(screen.getByRole("region", { name: "View AI work" })).queryByRole("button")).toBeNull();

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

    const workRecord = screen.queryByRole("region", { name: "View AI work" });
    const finalAnswer = screen.getByText("Final answer has started");
    expect(within(workRecord!).queryByRole("button")).toBeNull();
    expect(
      workRecord!.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

    const workRecord = screen.queryByRole("region", { name: "View AI work" });
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
    const updateTitle = within(workRecord).getByText("AI update");
    const updateRow = updateTitle.closest<HTMLElement>("[role=listitem]");
    expect(updateRow).not.toBeNull();
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

  it("hides the Personal AI author label beside agent avatars", () => {
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

    expect(screen.getByText("Administrator")).toBeVisible();
    expect(screen.getByText("here is the answer")).toBeVisible();
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
});
