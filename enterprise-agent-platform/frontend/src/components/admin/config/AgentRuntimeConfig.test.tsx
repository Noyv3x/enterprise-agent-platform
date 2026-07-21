// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import { AgentRuntimeConfig } from "./AgentRuntimeConfig";

const actions = vi.hoisted(() => ({
  saveAgentRuntimeConfig: vi.fn(),
}));

vi.mock("../../../data/adminActions", () => actions);

describe("AgentRuntimeConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("submits only the neutral runtime settings", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_AGENT_RUNTIME_CONFIG",
      payload: {
        config: {
          provider: "openai-codex",
          model: "gpt-5",
          idle_timeout_seconds: 1800,
          max_concurrency: 4,
          compaction_threshold: 0.8,
          model_catalog: {
            "openai-codex": { models: ["gpt-5"], default_model: "gpt-5" },
          },
        },
      },
    });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AgentRuntimeConfig />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    const save = screen.getByRole("button", { name: "Save runtime settings" });
    expect(save).toBeDisabled();

    const concurrency = screen.getByRole("spinbutton", { name: "Maximum concurrent tasks" });
    await userEvent.clear(concurrency);
    await userEvent.type(concurrency, "8");
    expect(save).toBeEnabled();
    await userEvent.click(save);

    expect(actions.saveAgentRuntimeConfig).toHaveBeenCalledWith(
      store,
      {
        provider: "openai-codex",
        model: "gpt-5",
        idle_timeout_seconds: "1800",
        max_concurrency: "8",
        compaction_threshold: "0.8",
      },
    );
  });
});
