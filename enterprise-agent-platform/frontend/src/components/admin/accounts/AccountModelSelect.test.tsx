// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import type { AgentRuntimeConfigState } from "../../../types";
import { AccountModelSelect } from "./AccountModelSelect";

function runtimeConfig(model: string, recommendedModel: string): AgentRuntimeConfigState {
  return {
    config: {
      provider: "openai-codex",
      model,
      model_catalog: {
        "openai-codex": {
          models: [recommendedModel, ...(model ? [model] : [])],
          default_model: recommendedModel,
        },
      },
    },
  };
}

describe("AccountModelSelect", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("shows the explicit deployment model before the runtime recommendation", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_AGENT_RUNTIME_CONFIG",
      payload: runtimeConfig("deployment-explicit-test", "future-recommended-test"),
    });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AccountModelSelect value="" onChange={() => undefined} />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText("System default (deployment-explicit-test)")).toBeInTheDocument();
    expect(screen.queryByText("System default (future-recommended-test)")).not.toBeInTheDocument();
  });

  it("updates the displayed recommendation when deployment model selection is automatic", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_AGENT_RUNTIME_CONFIG",
      payload: runtimeConfig("", "future-recommended-a"),
    });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AccountModelSelect value="" onChange={() => undefined} />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText("System default (future-recommended-a)")).toBeInTheDocument();

    act(() => {
      store.dispatch({
        type: "SET_AGENT_RUNTIME_CONFIG",
        payload: runtimeConfig("", "future-recommended-b"),
      });
    });

    expect(screen.getByText("System default (future-recommended-b)")).toBeInTheDocument();
    expect(screen.queryByText("System default (future-recommended-a)")).not.toBeInTheDocument();
  });

  it("does not retain runtime candidates after OAuth reports an empty catalog", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_AGENT_RUNTIME_CONFIG",
      payload: runtimeConfig("", "stale-runtime-candidate"),
    });
    store.dispatch({
      type: "SET_OAUTH_PROVIDERS",
      payload: {
        active_provider: "openai-codex",
        providers: [{
          id: "openai-codex",
          configured: true,
          models: [],
          default_model: "stale-runtime-candidate",
        }],
      },
    });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AccountModelSelect value="" onChange={() => undefined} />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText("Only the system default model is currently available.")).toBeInTheDocument();
    expect(screen.queryByText(/stale-runtime-candidate/)).not.toBeInTheDocument();
  });
});
