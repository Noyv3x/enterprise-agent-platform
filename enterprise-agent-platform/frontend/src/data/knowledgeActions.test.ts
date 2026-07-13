import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { clearSearch, openDocument, searchKnowledge } from "./knowledgeActions";

function response(body: object) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

describe("knowledge document selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the newest selection when document requests resolve out of order", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: { id: 1, username: "alice" } });
    const resolvers: Array<(value: ReturnType<typeof response>) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => resolvers.push(resolve))),
    );

    const first = openDocument(store, 10);
    const second = openDocument(store, 20);
    resolvers[1](response({ document: { id: 20, title: "New", content: "new" } }));
    await second;
    resolvers[0](response({ document: { id: 10, title: "Old", content: "old" } }));
    await first;

    expect(store.getState().selectedDocument?.id).toBe(20);
  });

  it("does not restore a pending search after the user clears it", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: { id: 1, username: "alice" } });
    let resolveSearch!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => { resolveSearch = resolve; })),
    );

    const pending = searchKnowledge(store, "old query");
    clearSearch(store);
    resolveSearch(response({ results: [{ id: 4, title: "Stale" }] }));
    await pending;

    expect(store.getState().knowledgeSearch).toEqual({ query: "", results: null });
  });
});
