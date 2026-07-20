// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import { RuntimeSettings } from "./RuntimeSettings";

const actions = vi.hoisted(() => ({
  restartRuntime: vi.fn(),
}));

vi.mock("../../../data/adminActions", () => actions);

describe("RuntimeSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("presents and restarts the managed search runtime explicitly", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_RUNTIMES",
      payload: {
        searxng: {
          name: "searxng",
          available: true,
          managed: true,
          state: "running",
          detail: "Managed search is ready",
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
    expect(
      screen.getByText(
        "Health of the Agent runtime, Cognee, Camofox, SearXNG search, and Firecrawl web extraction.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(actions.restartRuntime).toHaveBeenCalledWith(store, "searxng");
  });
});
