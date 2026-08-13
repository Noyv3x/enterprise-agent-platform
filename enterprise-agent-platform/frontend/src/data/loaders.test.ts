import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { RuntimeResponse, RuntimeState, User } from "../types";
import {
  clearRuntimeStatusRefresh,
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

describe("loadRuntime", () => {
  it("publishes the cached snapshot immediately and refreshes stale health in the background", async () => {
    vi.useFakeTimers();
    const rows = (stale: boolean, state: RuntimeState): RuntimeResponse => {
      const row = (name: string) => ({
        name,
        available: state === "running" || state === "available",
        state,
        detail: "",
        error: "",
        status_stale: stale,
        status_checked_at: stale ? null : 1_784_600_400,
      });
      return {
        agent: row("agent"),
        camofox: row("camofox"),
        searxng: row("searxng"),
        firecrawl: row("firecrawl"),
      };
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, rows(true, "unavailable")))
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
    expect(store.getState().runtimes?.agent?.state).toBe("unavailable");
    expect(store.getState().runtimes?.searxng?.state).toBe("unavailable");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().runtimes?.agent?.state).toBe("running");
    expect(store.getState().runtimes?.searxng?.state).toBe("running");

    clearRuntimeStatusRefresh(store);
    vi.useRealTimers();
  });
});
