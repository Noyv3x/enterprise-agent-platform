// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AppState, ChatMode, Message } from "../../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";

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

function renderIndicator(mode: ChatMode, overrides: Partial<AppState>) {
  const state: AppState = { ...initialAppState, ...overrides };
  const store = createStore(rootReducer, state);
  return render(
    <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <ContextUsageIndicator mode={mode} />
        </I18nProvider>
      </StoreContext.Provider>
    </ConfigProvider>,
  );
}

describe("composer context usage", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("shows the latest channel usage with formatted values and no provider or session details", async () => {
    const user = userEvent.setup();
    renderIndicator("channel", {
      messages: [agentMessage(1, 8_000, 128_000), agentMessage(2, 32_000, 128_000)],
      privateMessages: [agentMessage(3, 64_000, 128_000)],
    });

    await user.click(screen.getByRole("button", { name: "Context usage 25%" }));

    expect(screen.getByRole("group", { name: "Context usage" })).toBeInTheDocument();
    expect(screen.getByText("32,000")).toBeInTheDocument();
    expect(screen.getByText("128,000")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Context usage percentage" }))
      .toHaveAttribute("aria-valuenow", "25");
    expect(screen.queryByText(/provider|session/i)).not.toBeInTheDocument();
  });

  it("uses the private conversation independently from the active channel", () => {
    renderIndicator("private", {
      messages: [agentMessage(1, 16_000, 128_000)],
      privateMessages: [agentMessage(2, 64_000, 128_000)],
    });

    expect(screen.getByRole("button", { name: "Context usage 50%" })).toBeInTheDocument();
  });

  it("stays hidden until a completed reply reports usage", () => {
    renderIndicator("channel", { messages: [] });
    expect(screen.queryByRole("button", { name: /Context usage/ })).not.toBeInTheDocument();
  });

  it("does not present an older snapshot as the latest completed reply", () => {
    const latestWithoutUsage: Message = {
      id: 2,
      author_type: "agent",
      username: "Agent",
      content: "New reply without a snapshot",
      metadata: {},
    };
    renderIndicator("channel", { messages: [agentMessage(1, 32_000, 128_000), latestWithoutUsage] });
    expect(screen.queryByRole("button", { name: /Context usage/ })).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderIndicator("channel", { messages: [agentMessage(1, 32_000, 128_000)] });
    const trigger = screen.getByRole("button", { name: "Context usage 25%" });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(trigger).toHaveFocus();
  });
});
