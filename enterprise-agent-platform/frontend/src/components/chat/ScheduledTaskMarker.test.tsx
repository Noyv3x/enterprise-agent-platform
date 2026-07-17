// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { Message } from "../../types";
import { MessageBubble } from "./MessageBubble";

describe("ScheduledTaskMarker", () => {
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, "en"));
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("replaces a scheduled source prompt with a compact localized marker", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_USER",
      payload: { id: 7, username: "alice", display_name: "Alice", timezone: "UTC" },
    });
    const message: Message = {
      id: 100,
      scope_type: "private",
      scope_id: "7",
      author_type: "system",
      username: "Alice",
      content: "This full automation prompt should not take over the conversation.",
      metadata: {
        scheduled_task: {
          schedule_id: 9,
          schedule_run_id: 31,
          name: "Morning brief",
          scheduled_for: "2026-07-16T09:00:00Z",
        },
      },
      created_at: 1_768_000_000,
    };

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider><MessageBubble message={message} /></I18nProvider>
      </StoreContext.Provider>,
    );

    const marker = screen.getByRole("note", { name: /Scheduled task “Morning brief” triggered at/ });
    expect(marker).toHaveAttribute("data-schedule-id", "9");
    expect(marker).toHaveAttribute("data-schedule-run-id", "31");
    expect(screen.getByText("Morning brief")).toBeVisible();
    expect(screen.queryByText(message.content || "")).not.toBeInTheDocument();
  });

  it("keeps the Agent response visible when linkage metadata is copied to it", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: { id: 7, username: "alice", timezone: "UTC" } });
    const response: Message = {
      id: 101,
      scope_type: "private",
      scope_id: "7",
      author_type: "agent",
      username: "Private Agent",
      content: "Here is your completed morning brief.",
      metadata: {
        scheduled_task: {
          schedule_id: 9,
          schedule_run_id: 31,
          name: "Morning brief",
          scheduled_for: "2026-07-16T09:00:00Z",
        },
      },
      created_at: 1_768_000_001,
    };

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider><MessageBubble message={response} /></I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText("Here is your completed morning brief.")).toBeVisible();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
