// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { KnowledgeSearchForm } from "./KnowledgeSearchForm";

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

describe("KnowledgeSearchForm", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("commits a trimmed query only after success and can clear it", async () => {
    const user = userEvent.setup();
    const store = createStore(rootReducer, initialAppState);
    let resolveFetch!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <KnowledgeSearchForm />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    const input = screen.getByRole("textbox", { name: "Search knowledge base" });
    const submit = screen.getByRole("button", { name: "Search" });
    expect(submit).toBeDisabled();

    await user.type(input, "  graph agents  ");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/search?q=graph%20agents",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(store.getState().knowledgeSearch).toEqual({ query: "", results: null });
    expect(store.getState().resourceStates["knowledge:search"].status).toBe("loading");
    expect(screen.getByRole("button", { name: "Searching…" })).toBeDisabled();

    resolveFetch(response({ results: [{ id: 4, title: "Graph agents" }] }));
    await waitFor(() => {
      expect(store.getState().knowledgeSearch).toEqual({
        query: "graph agents",
        results: [{ id: 4, title: "Graph agents" }],
      });
    });
    expect(input).toHaveValue("graph agents");
    expect(store.getState().resourceStates["knowledge:search"].status).toBe("ready");

    const clear = screen.getByRole("button", { name: "Clear search and show all entries" });
    const control = input.closest(".search-field__control");
    expect(control).toContainElement(clear);
    expect(control).not.toContainElement(screen.getByRole("button", { name: "Search" }));

    await user.click(clear);
    expect(store.getState().knowledgeSearch).toEqual({ query: "", results: null });
    expect(input).toHaveValue("");
  });
});
