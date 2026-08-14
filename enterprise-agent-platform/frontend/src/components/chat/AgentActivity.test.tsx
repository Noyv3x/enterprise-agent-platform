// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus } from "../../types";
import { AgentActivity } from "./AgentActivity";

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

describe("AgentActivity", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("does not attach a work-record thumbnail beside the live work card", () => {
    render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <AgentActivity status={browserStatus} />
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );

    expect(screen.getByText("Browser")).toBeVisible();
    expect(screen.queryByTestId("browser-work-preview")).not.toBeInTheDocument();
    expect(document.querySelector(".agent-activity__content")).not.toHaveClass("has-browser-preview");
  });
});
