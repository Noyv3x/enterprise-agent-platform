// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus, AppState, Message } from "../../types";
import { ChatPreviewContext } from "../preview/ChatPreviewContext";
import { MessageList } from "./MessageList";

vi.mock("../preview/BrowserWorkPreview", () => ({
  BrowserWorkPreview: () => <div data-testid="browser-work-preview" />,
}));

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const INITIAL_TIME_MS = Date.parse("2026-08-10T08:00:00Z");

function completedAgentMessage(
  id: number,
  content: string,
  runId: string,
  tool: string,
  createdAtMs = Date.now(),
): Message {
  return {
    id,
    scope_type: "channel",
    scope_id: "1",
    author_type: "agent",
    username: "Agent",
    content,
    created_at: Math.floor(createdAtMs / 1000),
    metadata: {
      agent_work: {
        run_id: runId,
        state: "complete",
        updated_at: Math.floor(createdAtMs / 1000),
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

function renderBrowserMessageList(
  status: AgentStatus,
  messages: Message[],
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
    messages,
    agentStatuses: { channels: { "1": status }, private: null },
  };
  const store = createStore(rootReducer, state);
  const tree = (browserDrawerOpen: boolean, scopeId = "1") => (
    <I18nProvider>
      <StoreContext.Provider value={store}>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "channel", scope_id: scopeId },
          browserDrawerOpen,
          openBrowserAssist: vi.fn(),
        }}>
          <MessageList mode="channel" scopeId={scopeId} noChannel={false} forceBottomToken={0} />
        </ChatPreviewContext.Provider>
      </StoreContext.Provider>
    </I18nProvider>
  );
  const view = render(tree(false));
  return {
    ...view,
    store,
    setBrowserDrawerOpen: (open: boolean) => view.rerender(tree(open)),
    setScope: (scopeId: string) => view.rerender(tree(false, scopeId)),
  };
}

function previewArticle(): HTMLElement {
  const article = screen.getByTestId("browser-work-preview").closest("article");
  if (!article) throw new Error("browser preview is not attached to a message");
  return article;
}

describe("MessageList retained browser work preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(INITIAL_TIME_MS);
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("keeps a completed browser preview for exactly five minutes", () => {
    renderBrowserMessageList(
      { state: "idle" },
      [completedAgentMessage(1, "Browser answer", "run-browser", "browser")],
    );

    expect(previewArticle()).toHaveTextContent("Browser answer");
    act(() => vi.advanceTimersByTime(FIVE_MINUTES_MS - 1));
    expect(previewArticle()).toHaveTextContent("Browser answer");

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
  });

  it("does not move or extend the preview for later non-browser work", () => {
    const browserMessage = completedAgentMessage(
      1,
      "Browser answer",
      "run-browser",
      "browser",
    );
    const view = renderBrowserMessageList({ state: "idle" }, [browserMessage]);

    act(() => vi.advanceTimersByTime(4 * 60 * 1000));
    const nonBrowserMessage = completedAgentMessage(
      2,
      "Terminal answer",
      "run-terminal",
      "terminal",
    );
    act(() => view.store.dispatch({
      type: "SET_MESSAGES",
      payload: [browserMessage, nonBrowserMessage],
    }));

    expect(previewArticle()).toHaveTextContent("Browser answer");
    expect(previewArticle()).not.toHaveTextContent("Terminal answer");

    act(() => vi.advanceTimersByTime(60 * 1000));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
  });

  it("keeps the old deadline while a later non-browser run is active", () => {
    const browserMessage = completedAgentMessage(
      1,
      "Browser answer",
      "run-browser",
      "browser",
    );
    const view = renderBrowserMessageList({ state: "idle" }, [browserMessage]);
    act(() => vi.advanceTimersByTime(4 * 60 * 1000));

    act(() => view.store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: {
        mode: "channel",
        scopeId: "1",
        status: {
          run_id: "run-terminal",
          state: "replying",
          started_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
          activity: [{
            stage: "tool.started",
            tool: "terminal",
            tool_call_id: "terminal-new",
            tool_status: "running",
          }],
        },
      },
    }));

    expect(previewArticle()).toHaveTextContent("Browser answer");
    act(() => vi.advanceTimersByTime(60 * 1000));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
  });

  it("moves to a new browser run immediately and restarts retention on completion", () => {
    const oldBrowserMessage = completedAgentMessage(
      1,
      "Old browser answer",
      "run-browser-old",
      "browser",
    );
    const view = renderBrowserMessageList({ state: "idle" }, [oldBrowserMessage]);
    act(() => vi.advanceTimersByTime(4 * 60 * 1000));

    const activeStatus: AgentStatus = {
      run_id: "run-browser-new",
      state: "replying",
      started_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
      activity: [{
        stage: "tool.started",
        tool: "browser",
        tool_call_id: "browser-new",
        tool_status: "running",
      }],
    };
    act(() => view.store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "channel", scopeId: "1", status: activeStatus },
    }));

    expect(screen.getAllByTestId("browser-work-preview")).toHaveLength(1);
    expect(previewArticle()).toHaveClass("msg--activity");
    expect(previewArticle()).not.toHaveTextContent("Old browser answer");

    const newBrowserMessage = completedAgentMessage(
      2,
      "New browser answer",
      "run-browser-new",
      "browser",
    );
    act(() => {
      view.store.dispatch({
        type: "SET_MESSAGES",
        payload: [oldBrowserMessage, newBrowserMessage],
      });
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: {
          mode: "channel",
          scopeId: "1",
          authoritative: true,
          status: {
            run_id: "run-browser-new",
            state: "complete",
            updated_at: Math.floor(Date.now() / 1000),
          },
        },
      });
    });

    expect(screen.getAllByTestId("browser-work-preview")).toHaveLength(1);
    expect(previewArticle()).toHaveTextContent("New browser answer");
    act(() => vi.advanceTimersByTime(FIVE_MINUTES_MS - 1));
    expect(previewArticle()).toHaveTextContent("New browser answer");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
  });

  it("uses the absolute completion deadline after an unmount and remount", () => {
    const message = completedAgentMessage(
      1,
      "Browser answer",
      "run-browser",
      "browser",
    );
    const first = renderBrowserMessageList({ state: "idle" }, [message]);
    act(() => vi.advanceTimersByTime(4 * 60 * 1000));
    first.unmount();

    const second = renderBrowserMessageList({ state: "idle" }, [message]);
    expect(previewArticle()).toHaveTextContent("Browser answer");
    act(() => vi.advanceTimersByTime(60 * 1000));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
    second.unmount();
  });

  it("unmounts under the full drawer without extending the original deadline", () => {
    const message = completedAgentMessage(
      1,
      "Browser answer",
      "run-browser",
      "browser",
    );
    const view = renderBrowserMessageList({ state: "idle" }, [message]);
    act(() => vi.advanceTimersByTime(4 * 60 * 1000));

    view.setBrowserDrawerOpen(true);
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30 * 1000));

    view.setBrowserDrawerOpen(false);
    expect(previewArticle()).toHaveTextContent("Browser answer");
    act(() => vi.advanceTimersByTime(30 * 1000));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
  });

  it("does not attach old-scope work during a channel transition or renew it on return", () => {
    const message = completedAgentMessage(
      1,
      "Browser answer",
      "run-browser",
      "browser",
    );
    const view = renderBrowserMessageList({ state: "idle" }, [message]);
    act(() => vi.advanceTimersByTime(4 * 60 * 1000));

    view.setScope("2");
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30 * 1000));

    view.setScope("1");
    expect(previewArticle()).toHaveTextContent("Browser answer");
    act(() => vi.advanceTimersByTime(30 * 1000));
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
  });
});
