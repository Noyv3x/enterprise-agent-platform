// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus } from "../../types";
import { ChatPreviewContext, type ChatPreviewContextValue } from "../preview/ChatPreviewContext";
import { AgentActivity } from "./AgentActivity";

vi.mock("../preview/BrowserWorkPreview", () => ({
  BrowserWorkPreview: () => <div data-testid="browser-work-preview" />,
}));

const store = createStore(rootReducer, initialAppState);
const browserStatus: AgentStatus = {
  run_id: "run-browser",
  state: "replying",
  activity: [
    {
      stage: "tool.started",
      tool: "browser",
      tool_call_id: "browser-1",
      tool_status: "running",
    },
  ],
};

function renderActivity(context: ChatPreviewContextValue, status: AgentStatus = browserStatus) {
  return render(
    <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <ChatPreviewContext.Provider value={context}>
            <AgentActivity status={status} />
          </ChatPreviewContext.Provider>
        </I18nProvider>
      </StoreContext.Provider>
    </ConfigProvider>,
  );
}

describe("AgentActivity browser work preview", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows the adjacent preview from the browser tool event without waiting for availability", () => {
    renderActivity({
      scope: { scope_type: "private", scope_id: "7" },
      browserDrawerOpen: false,
      openBrowserAssist: vi.fn(),
    });

    expect(screen.getByTestId("browser-work-preview")).toBeVisible();
    expect(document.querySelector(".agent-activity__content")).toHaveClass("has-browser-preview");
  });

  it("unmounts the thumbnail consumer while the full browser drawer is open", () => {
    const context: ChatPreviewContextValue = {
      scope: { scope_type: "private", scope_id: "7" },
      browserDrawerOpen: false,
      openBrowserAssist: vi.fn(),
    };
    const view = renderActivity(context);
    expect(screen.getByTestId("browser-work-preview")).toBeVisible();

    view.rerender(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <ChatPreviewContext.Provider value={{ ...context, browserDrawerOpen: true }}>
              <AgentActivity status={browserStatus} />
            </ChatPreviewContext.Provider>
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );

    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
    expect(document.querySelector(".agent-activity__content")).not.toHaveClass("has-browser-preview");
  });
});
