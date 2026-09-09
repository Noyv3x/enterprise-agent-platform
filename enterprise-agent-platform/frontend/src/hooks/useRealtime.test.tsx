// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { StoreContext } from "../store/StoreProvider";
import type { Message, User } from "../types";
import { useRealtime } from "./useRealtime";

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 0;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  /** The browser gave up: CLOSED plus a final error event. */
  fail() {
    this.readyState = 2;
    this.dispatchEvent(new Event("error"));
  }

  update(payload: unknown) {
    this.dispatchEvent(new MessageEvent("update", { data: JSON.stringify(payload) }));
  }
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** Let the auth probe's fetch/text/throw chain settle without advancing timers. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

describe("useRealtime compact updates", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    resetApiSession();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates streaming status directly and fetches only for a new message revision", async () => {
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const current = {
      id: 10,
      author_type: "user",
      content: "current",
      scope_type: "private",
      scope_id: "7",
    } as Message;
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [current],
      messageSyncCursors: { "private:7": { afterId: "10", revision: 4 } },
    });
    const fetchMock = vi.fn(async (_path: string) => response({
      mode: "delta",
      message_revision: 5,
      messages: [{ ...current, id: 11, content: "next" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );

    const { result } = renderHook(() => useRealtime(), { wrapper });
    const stream = FakeEventSource.instances[0];
    act(() => stream.open());
    expect(result.current).toBe(true);

    act(() => stream.update({
      message_revision: 4,
      latest_message_id: 10,
      agent_status: {
        state: "replying",
        stream_message: { content: "working" },
      },
    }));
    expect(store.getState().agentStatuses.private?.stream_message?.content).toBe("working");
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => stream.update({ message_revision: 5, latest_message_id: 11 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.getState().privateMessages).toHaveLength(2));
  });

  it("keeps the active scope stream open while the loaded page is hidden", () => {
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );
    renderHook(() => useRealtime(), { wrapper });
    const stream = FakeEventSource.instances[0];
    act(() => stream.open());

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(stream.readyState).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("keeps recovering with bounded backoff when the post-close auth probe fails transiently", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const store = createStore(rootReducer, { ...initialAppState, user, activeView: "private" });
    const fetchMock = vi.fn(async (_path: string) =>
      response({ user }, fetchMock.mock.calls.length === 1 ? 502 : 200),
    );
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );

    const { unmount } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      FakeEventSource.instances[0].open();
      FakeEventSource.instances[0].fail();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    // The failed probe is retried after the base delay; the successful probe then
    // schedules the ordinary reconnect, so a new stream appears without any
    // visibility or pageshow event.
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Teardown cancels a pending recovery instead of leaking a later reconnect.
    act(() => FakeEventSource.instances[1].fail());
    await settle();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
