// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus, AppState, Message } from "../../types";
import { ChatPreviewContext } from "../preview/ChatPreviewContext";
import { MessageList } from "./MessageList";

function completedAgentMessage(
  id: number,
  content: string,
  runId: string,
  tool: string,
): Message {
  return {
    id,
    scope_type: "channel",
    scope_id: "1",
    author_type: "agent",
    username: "Agent",
    content,
    metadata: {
      agent_work: {
        run_id: runId,
        state: "complete",
        activity: [{
          stage: "tool.completed",
          tool,
          tool_call_id: `${tool}-${runId}`,
          tool_status: "completed",
        }],
      },
    },
  };
}

function renderMessageList(status: AgentStatus, messages: Message[]) {
  const state: AppState = {
    ...initialAppState,
    user: {
      id: 1,
      username: "admin",
      display_name: "Administrator",
      role: "admin",
    },
    activeChannelId: 1,
    messages,
    agentStatuses: { channels: { "1": status }, private: null },
  };
  const store = createStore(rootReducer, state);
  return render(
    <I18nProvider>
      <StoreContext.Provider value={store}>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "channel", scope_id: "1" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: null,
          computerSurface: null,
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <MessageList mode="channel" scopeId="1" noChannel={false} forceBottomToken={0} />
        </ChatPreviewContext.Provider>
      </StoreContext.Provider>
    </I18nProvider>,
  );
}

describe("MessageList computer thumbnails", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("does not keep a completed browser thumbnail next to the work record", () => {
    renderMessageList(
      { state: "idle" },
      [completedAgentMessage(1, "Browser answer", "run-browser", "browser")],
    );

    expect(screen.getByText("Browser answer")).toBeVisible();
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
    expect(document.querySelector(".agent-work-preview-row")).not.toBeInTheDocument();
  });
});
