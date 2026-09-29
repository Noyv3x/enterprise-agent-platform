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
import { usePolling } from "./usePolling";

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

/** Let scoped fetch/text/dispatch work settle without advancing timers. */
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
    fetchMock.mockResolvedValueOnce(response({
      mode: "delta", message_revision: 4, messages: [],
    }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );

    const { result } = renderHook(() => useRealtime(), { wrapper });
    const stream = FakeEventSource.instances[0];
    act(() => stream.open());
    expect(result.current).toBe(true);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();

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

  it("keeps the active scope stream open while the loaded page is hidden", async () => {
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    vi.stubGlobal("fetch", vi.fn(async () => response({ messages: [] })));
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
    await settle();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(stream.readyState).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("catches up on native reconnect and polls only while disconnected", async () => {
    vi.useFakeTimers();
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const store = createStore(rootReducer, { ...initialAppState, user, activeView: "private" });
    let content = "initial";
    const fetchMock = vi.fn(async () => response({
      messages: [{ id: 1, author_type: "agent", content, scope_type: "private", scope_id: "7" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );
    const { unmount } = renderHook(() => {
      const connected = useRealtime();
      usePolling(!connected);
    }, { wrapper });
    const stream = FakeEventSource.instances[0];
    act(() => stream.open());
    await settle();
    expect(store.getState().privateMessages[0]?.content).toBe("initial");
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      stream.readyState = 0;
      stream.dispatchEvent(new Event("error"));
    });
    await settle();
    fetchMock.mockClear();
    content = "missed while disconnected";
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(store.getState().privateMessages[0]?.content).toBe("missed while disconnected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    content = "missed before reconnect";
    act(() => stream.open());
    await settle();
    expect(store.getState().privateMessages[0]?.content).toBe("missed before reconnect");
    expect(FakeEventSource.instances).toEqual([stream]);

    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).not.toHaveBeenCalled();
    content = "missed while hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(store.getState().privateMessages[0]?.content).toBe("missed while hidden");
    unmount();
  });

  it("reconciles channel access loss on SSE disconnect and never reconnects the removed scope", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const user = { id: 7, username: "viewer", permissions: ["read_workspace"] } as User;
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "channel",
      activeChannelId: 3,
      channels: [{ id: 3, name: "removed" }, { id: 4, name: "remaining" }],
    });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/channels/3/messages") return response({ error: "Unavailable" }, 404);
      if (path === "/api/channels") return response({ channels: [{ id: 4, name: "remaining" }] });
      if (path === "/api/auth/me") return response({ user });
      return response({ messages: [], typing: [] });
    }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );
    renderHook(() => useRealtime(), { wrapper });
    const removed = FakeEventSource.instances[0];
    act(() => {
      removed.open();
      removed.fail();
    });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.getState().activeChannelId).toBe(4);
    expect(store.getState().channels).toEqual([{ id: 4, name: "remaining" }]);
    expect(FakeEventSource.instances.map((stream) => stream.url)).toEqual([
      "/api/channels/3/events", "/api/channels/4/events",
    ]);
    act(() => removed.update({ agent_status: { state: "replying" }, typing: [{ user_id: 7 }] }));
    expect(store.getState().agentStatuses.channels["3"]).toBeUndefined();
    expect(store.getState().typingUsers).toEqual([]);
  });

  it("ignores an outgoing actor's events before React cleans up the old stream", () => {
    const user = { id: 7, username: "viewer", permissions: ["read_workspace"] } as User;
    const store = createStore(rootReducer, {
      ...initialAppState, user, activeView: "channel", activeChannelId: 3,
    });
    const fetchMock = vi.fn(async () => response({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );
    renderHook(() => useRealtime(), { wrapper });
    const outgoing = FakeEventSource.instances[0];
    act(() => {
      store.dispatch({ type: "SET_USER", payload: { ...user, id: 8 } });
      outgoing.update({ agent_status: { state: "replying" }, message_revision: 9 });
      outgoing.fail();
    });
    expect(store.getState().agentStatuses.channels["3"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
