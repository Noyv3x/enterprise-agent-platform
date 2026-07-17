// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { browserTimezone, ensureCurrentUserTimezone } from "./accountActions";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("current-user time zone", () => {
  it("detects the browser IANA time zone", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }) }) as Intl.DateTimeFormat,
    );
    expect(browserTimezone()).toBe("Asia/Shanghai");
  });

  it("persists an unset time zone once and leaves explicit preferences alone", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }) }) as Intl.DateTimeFormat,
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: { id: 7, username: "alice", display_name: "Alice", timezone: "Asia/Shanghai" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: { id: 7, username: "alice", display_name: "Alice" } });

    await Promise.all([
      ensureCurrentUserTimezone(store, 7, undefined),
      ensureCurrentUserTimezone(store, 7, undefined),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/me");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ timezone: "Asia/Shanghai" });
    expect(store.getState().user?.timezone).toBe("Asia/Shanghai");

    await ensureCurrentUserTimezone(store, 7, "Europe/Paris");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
