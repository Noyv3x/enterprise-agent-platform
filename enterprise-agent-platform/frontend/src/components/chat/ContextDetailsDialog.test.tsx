// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AppState, Message } from "../../types";
import { TopbarActions } from "../shell/TopbarActions";

function agentMessage(id: number, used: number, maximum: number): Message {
  return {
    id,
    author_type: "agent",
    username: "Agent",
    content: "Done",
    metadata: {
      context_usage: {
        used_tokens: used,
        max_tokens: maximum,
        percent: 99,
        estimated: false,
      },
    },
  };
}

function renderActions(overrides: Partial<AppState>) {
  const state: AppState = { ...initialAppState, ...overrides };
  const store = createStore(rootReducer, state);
  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <TopbarActions />
      </I18nProvider>
    </StoreContext.Provider>,
  );
}

describe("conversation context details", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("shows the latest channel context usage without provider or session details", async () => {
    const user = userEvent.setup();
    renderActions({
      activeView: "channel",
      activeChannelId: 1,
      messages: [agentMessage(1, 8_000, 128_000), agentMessage(2, 32_000, 128_000)],
      privateMessages: [agentMessage(3, 64_000, 128_000)],
    });

    await user.click(screen.getByRole("button", { name: "Details" }));

    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    expect(screen.getByText("32,000 / 128,000 tokens")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Context usage percentage" }))
      .toHaveAttribute("aria-valuenow", "25");
    expect(screen.queryByText(/provider|session/i)).not.toBeInTheDocument();
  });

  it("uses the private conversation independently from the active channel", async () => {
    const user = userEvent.setup();
    renderActions({
      activeView: "private",
      messages: [agentMessage(1, 16_000, 128_000)],
      privateMessages: [agentMessage(2, 64_000, 128_000)],
    });

    await user.click(screen.getByRole("button", { name: "Details" }));

    expect(screen.getByText("64,000 / 128,000 tokens")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  });

  it("keeps the details button useful before a context snapshot exists", async () => {
    const user = userEvent.setup();
    renderActions({ activeView: "channel", activeChannelId: 1, messages: [] });

    await user.click(screen.getByRole("button", { name: "Details" }));

    expect(
      screen.getByText("Context usage will appear after the Agent completes a reply."),
    ).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("does not mislabel an older snapshot as the latest completed reply", async () => {
    const user = userEvent.setup();
    const latestWithoutUsage: Message = {
      id: 2,
      author_type: "agent",
      username: "Agent",
      content: "New reply without a snapshot",
      metadata: {},
    };
    renderActions({
      activeView: "channel",
      activeChannelId: 1,
      messages: [agentMessage(1, 32_000, 128_000), latestWithoutUsage],
    });

    await user.click(screen.getByRole("button", { name: "Details" }));

    expect(
      screen.getByText("Context usage will appear after the Agent completes a reply."),
    ).toBeVisible();
    expect(screen.queryByText("32,000 / 128,000 tokens")).not.toBeInTheDocument();
  });

  it("does not show conversation details until a channel is selected", () => {
    renderActions({ activeView: "channel", activeChannelId: null });
    expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
  });
});
