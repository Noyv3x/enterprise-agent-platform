// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus, AppState } from "../../types";
import { MessageList } from "./MessageList";

function renderMessageList(status: AgentStatus) {
  const state: AppState = {
    ...initialAppState,
    user: {
      id: 1,
      username: "admin",
      display_name: "Administrator",
      role: "admin",
    },
    activeChannelId: 1,
    agentStatuses: { channels: { "1": status }, private: null },
  };
  const store = createStore(rootReducer, state);
  return render(
    <I18nProvider>
      <StoreContext.Provider value={store}>
        <MessageList mode="channel" scopeId="1" noChannel={false} forceBottomToken={0} />
      </StoreContext.Provider>
    </I18nProvider>,
  );
}

describe("MessageList Agent work records", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("uses the lightweight replying indicator when no tool was called", () => {
    const view = renderMessageList({
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "queued" },
        { source: "platform", stage: "replying" },
      ],
    });

    expect(screen.getByText("Agent is replying to Administrator")).toBeTruthy();
    expect(view.container.querySelector(".agent-work")).toBeNull();
  });

  it("keeps approval separate from work records when no tool was called", () => {
    const view = renderMessageList({
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
    expect(view.container.querySelector(".agent-work")).toBeNull();
  });

  it("shows a normal error message instead of an empty work record", () => {
    const view = renderMessageList({
      state: "error",
      last_error: "Runtime unavailable",
      activity: [{ source: "platform", stage: "error", detail: "Runtime unavailable" }],
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Agent reply failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
    expect(view.container.querySelector(".agent-work")).toBeNull();
  });

  it("creates a work record once a real tool call exists", () => {
    const view = renderMessageList({
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

    expect(view.container.querySelector(".agent-work")).not.toBeNull();
    expect(screen.getByText(/Using Web search/)).toBeTruthy();
    expect(screen.queryByText(/Unrelated lifecycle row/)).toBeNull();
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
});
