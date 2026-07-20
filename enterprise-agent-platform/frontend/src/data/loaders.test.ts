import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestCancelledError, resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { User } from "../types";
import {
  clearRuntimeStatusRefresh,
  loadMentionTargets,
  loadRuntime,
} from "./loaders";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.useRealTimers();
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

describe("loadRuntime", () => {
  it("publishes the cached snapshot immediately and refreshes stale health in the background", async () => {
    vi.useFakeTimers();
    const rows = (stale: boolean, state: string) => ({
      agent: { name: "agent", state, status_stale: stale },
      cognee: { name: "cognee", state, status_stale: stale },
      camofox: { name: "camofox", state, status_stale: stale },
      searxng: { name: "searxng", state, status_stale: stale },
      firecrawl: { name: "firecrawl", state, status_stale: stale },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, rows(true, "starting")))
      .mockResolvedValueOnce(response(200, rows(false, "running")));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user: {
        id: 7,
        username: "admin",
        permissions: ["admin"],
      } as User,
    });

    await loadRuntime(store);
    expect(store.getState().runtimes?.agent?.state).toBe("starting");
    expect(store.getState().runtimes?.searxng?.state).toBe("starting");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().runtimes?.agent?.state).toBe("running");
    expect(store.getState().runtimes?.searxng?.state).toBe("running");

    clearRuntimeStatusRefresh(store);
    vi.useRealTimers();
  });
});
