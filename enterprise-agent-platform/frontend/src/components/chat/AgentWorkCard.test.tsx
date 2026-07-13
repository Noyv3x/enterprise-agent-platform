// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("shows the current step once and keeps anonymous argument deltas out of the log", () => {
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
          detail: "pwd",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "search_files",
          tool_call_id: "search-1",
          tool_status: "completed",
          detail: "config · ./src",
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

    expect(screen.getAllByText("✅ Completed File search · config · ./src")).toHaveLength(1);
    expect(screen.getAllByText("✅ Completed Command · pwd")).toHaveLength(1);
    expect(screen.queryByText(/Using tool/i)).toBeNull();
  });
});
