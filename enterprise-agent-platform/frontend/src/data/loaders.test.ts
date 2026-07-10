import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestCancelledError, resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { loadMentionTargets } from "./loaders";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
});

describe("loadMentionTargets", () => {
  it("does not dispatch a fallback after the old session request is cancelled", async () => {
    let resolveFetch!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const store = createStore(rootReducer, initialAppState);
    const oldRequest = loadMentionTargets(store);

    resetApiSession();
    store.dispatch({
      type: "SET_MENTION_TARGETS",
      payload: [{ kind: "user", handle: "new-user", label: "New User" }],
    });
    resolveFetch(response(200, { targets: [{ handle: "old-user" }] }));

    await expect(oldRequest).rejects.toBeInstanceOf(ApiRequestCancelledError);
    expect(store.getState().mentionTargets).toEqual([
      { kind: "user", handle: "new-user", label: "New User" },
    ]);
  });

  it("keeps the empty fallback for an ordinary mention endpoint failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_MENTION_TARGETS",
      payload: [{ kind: "user", handle: "stale-user" }],
    });

    await expect(loadMentionTargets(store)).resolves.toBeUndefined();
    expect(store.getState().mentionTargets).toEqual([]);
  });
});
