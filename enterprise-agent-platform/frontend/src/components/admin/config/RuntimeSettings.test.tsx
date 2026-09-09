// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import { RuntimeSettings } from "./RuntimeSettings";

describe("RuntimeSettings", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("presents managed runtime health without a direct lifecycle action", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_RUNTIMES",
      payload: {
        searxng: {
          name: "searxng",
          available: true,
          state: "running",
          detail: "Managed search is ready",
          error: "",
          status_stale: false,
          status_checked_at: 1_784_600_400,
        },
      },
    });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <RuntimeSettings />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText("SearXNG search")).toBeInTheDocument();
    expect(screen.getByText("Managed search is ready")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  });

  it("does not treat an unknown service state as ready", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_RUNTIMES",
      payload: {
        searxng: {
          name: "searxng",
          available: true,
          state: undefined as never,
          detail: "",
          error: "",
          status_stale: true,
          status_checked_at: null,
        },
      },
    });
    render(<StoreContext.Provider value={store}><I18nProvider><RuntimeSettings /></I18nProvider></StoreContext.Provider>);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });
});
