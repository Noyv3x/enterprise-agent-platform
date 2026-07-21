// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus } from "../../types";
import { AgentWorkCard } from "./AgentWorkCard";

describe("AgentWorkCard", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("renders structured tool states and a complete terminal command preview", () => {
    const store = createStore(rootReducer, initialAppState);
    const work: AgentStatus = {
      run_id: "run-1",
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "replying" },
        { source: "agent", stage: "tool", tool: "tool", detail: "tool" },
        {
          source: "agent",
          stage: "tool",
          tool: "terminal",
          tool_call_id: "terminal-1",
          tool_status: "completed",
          detail: "npm test -- --runInBand frontend/src/components/chat/AgentWorkCard.test.tsx",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "search_files",
          tool_call_id: "search-1",
          tool_status: "completed",
          detail: "config · ./src",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "session_search",
          tool_call_id: "session-search-1",
          tool_status: "completed",
          detail: "release notes",
        },
      ],
    };

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AgentWorkCard work={work} active={true} />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText("Command")).toBeVisible();
    expect(screen.getByText("File search")).toBeVisible();
    expect(screen.getByText("Session search")).toBeVisible();
    expect(screen.getAllByText("Completed")).toHaveLength(3);
    const commandPreview = screen.getByLabelText("Terminal command");
    expect(commandPreview).toHaveTextContent(
      "npm test -- --runInBand frontend/src/components/chat/AgentWorkCard.test.tsx",
    );
    expect(commandPreview).toHaveAttribute("tabindex", "0");
    commandPreview.focus();
    expect(commandPreview).toHaveFocus();
    expect(screen.getByText("Agent is working")).toBeVisible();
    expect(document.querySelectorAll(".agent-work__item")).toHaveLength(3);
    expect(screen.queryByText(/Using tool/i)).toBeNull();
  });

  it("auto-collapses once and still allows the user to reopen it", () => {
    const store = createStore(rootReducer, initialAppState);
    const work: AgentStatus = {
      run_id: "run-collapse",
      state: "replying",
      activity: [
        {
          stage: "tool",
          tool: "web",
          tool_call_id: "web-1",
          tool_status: "completed",
        },
      ],
    };
    const renderCard = (finalOutputStarted: boolean) => (
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AgentWorkCard
            work={work}
            active={true}
            finalOutputStarted={finalOutputStarted}
          />
        </I18nProvider>
      </StoreContext.Provider>
    );
    const view = render(renderCard(false));
    const details = () => view.container.querySelector("details");

    expect(details()).toHaveAttribute("open");
    view.rerender(renderCard(true));
    expect(details()).not.toHaveAttribute("open");

    fireEvent.click(view.container.querySelector("summary")!);
    expect(details()).toHaveAttribute("open");
    view.rerender(renderCard(true));
    expect(details()).toHaveAttribute("open");

    view.rerender(renderCard(false));
    expect(details()).toHaveAttribute("open");
    view.rerender(renderCard(true));
    expect(details()).not.toHaveAttribute("open");
  });
});
