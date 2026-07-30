import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { Message, User } from "../types";
import {
  applyScopeRealtimeUpdate,
  navigateToView,
  refreshActiveChat,
  selectChannel,
} from "./chatActions";
import { loadOlderMessages } from "./loaders";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const user = {
  id: 7,
  username: "alice",
  permissions: ["chat", "private_agent"],
} as User;

function message(id: number, content: string): Message {
  return { id, author_type: "user", content, scope_type: "channel", scope_id: "1" };
}

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
});

describe("chat transport performance", () => {
  it("applies realtime status without requesting messages until the revision changes", () => {
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [{ ...message(10, "current"), scope_type: "private", scope_id: "7" }],
      messageSyncCursors: { "private:7": { afterId: "10", revision: 4 } },
    });

    expect(applyScopeRealtimeUpdate(store, "private", "7", {
      message_revision: 4,
      latest_message_id: 10,
      agent_status: { state: "replying", stream_message: { content: "working" } },
    })).toBe(false);
    expect(store.getState().agentStatuses.private?.stream_message?.content).toBe("working");

    expect(applyScopeRealtimeUpdate(store, "private", "7", {
      message_revision: 5,
      latest_message_id: 11,
    })).toBe(true);
  });

  it("requests a delta and merges it without downloading the existing history", async () => {
    const fetchMock = vi.fn(async (_path: string) => response(200, {
      mode: "delta",
      message_revision: 5,
      messages: [{ ...message(11, "new"), scope_type: "private", scope_id: "7" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [{ ...message(10, "current"), scope_type: "private", scope_id: "7" }],
      messageSyncCursors: { "private:7": { afterId: "10", revision: 4 } },
    });

    await refreshActiveChat(store);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/private-agent/messages?after_id=10&since_revision=4",
    );
    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([10, 11]);
    expect(store.getState().messageSyncCursors["private:7"]).toEqual({
      afterId: "11",
      revision: 5,
    });
  });

  it("does not advance the sync cursor past an unread message after a POST resolves", async () => {
    const fetchMock = vi.fn(async (_path: string) => response(200, {
      mode: "delta",
      message_revision: 6,
      next_after_id: 12,
      messages: [
        { ...message(11, "remote"), scope_type: "private", scope_id: "7" },
        { ...message(12, "saved locally"), scope_type: "private", scope_id: "7" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      // Message 12 came from the POST response, while the last completed server
      // synchronization was still message 10 / revision 4.
      privateMessages: [
        { ...message(10, "current"), scope_type: "private", scope_id: "7" },
        { ...message(12, "saved locally"), scope_type: "private", scope_id: "7" },
      ],
      messageSyncCursors: { "private:7": { afterId: "10", revision: 4 } },
    });

    await refreshActiveChat(store);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/private-agent/messages?after_id=10&since_revision=4",
    );
    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([10, 11, 12]);
    expect(store.getState().messageSyncCursors["private:7"]).toEqual({
      afterId: "12",
      revision: 6,
    });
  });

  it("retains already loaded history when an incremental delta arrives", async () => {
    const delta = Array.from({ length: 10 }, (_, index) => ({
      ...message(101 + index, `new ${index}`),
      scope_type: "private" as const,
      scope_id: "7",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => response(200, {
      mode: "delta",
      message_revision: 110,
      messages: delta,
    })));
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: Array.from({ length: 100 }, (_, index) => ({
        ...message(index + 1, `history ${index}`),
        scope_type: "private" as const,
        scope_id: "7",
      })),
      messageSyncCursors: { "private:7": { afterId: "100", revision: 100 } },
    });

    await refreshActiveChat(store);

    const retained = store.getState().privateMessages;
    expect(retained).toHaveLength(110);
    expect(retained[0]?.id).toBe(1);
    expect(retained[retained.length - 1]?.id).toBe(110);
  });

  it("prepends a before_id page without advancing the forward sync cursor", async () => {
    const fetchMock = vi.fn(async () => response(200, {
      mode: "history",
      messages: [
        { ...message(99, "older 99"), scope_type: "private", scope_id: "7" },
        { ...message(100, "older 100"), scope_type: "private", scope_id: "7" },
        { ...message(101, "duplicate"), scope_type: "private", scope_id: "7" },
      ],
      has_more_before: true,
      next_before_id: 99,
      message_revision: 202,
      reset_revision: 0,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [
        { ...message(101, "current 101"), scope_type: "private", scope_id: "7" },
        { ...message(102, "current 102"), scope_type: "private", scope_id: "7" },
      ],
      messageSyncCursors: {
        "private:7": { afterId: "102", revision: 202, resetRevision: 0 },
      },
      messageHistory: {
        "private:7": {
          nextBeforeId: "101",
          hasMore: true,
          loading: false,
          error: "",
          prependVersion: 0,
        },
      },
    });

    await loadOlderMessages(store, "private", "7");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private-agent/messages?before_id=101&limit=100",
      expect.anything(),
    );
    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([
      99,
      100,
      101,
      102,
    ]);
    expect(store.getState().messageSyncCursors["private:7"]).toEqual({
      afterId: "102",
      revision: 202,
      resetRevision: 0,
    });
    expect(store.getState().messageHistory["private:7"]).toMatchObject({
      nextBeforeId: "99",
      hasMore: true,
      loading: false,
      prependVersion: 1,
    });
  });

  it("does not request history without a server reset boundary", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      messageSyncCursors: { "private:7": { afterId: "101", revision: 4 } },
      messageHistory: {
        "private:7": {
          nextBeforeId: "101",
          hasMore: true,
          loading: false,
          error: "",
          prependVersion: 0,
        },
      },
    });

    await loadOlderMessages(store, "private", "7");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().messageHistory["private:7"]?.loading).toBe(false);
  });

  it("does not let a replaced history request clear or overwrite its successor", async () => {
    const resolvers: Array<(value: ReturnType<typeof response>) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolvers.push(resolve);
    })));
    const initialHistory = {
      nextBeforeId: "101",
      hasMore: true,
      loading: false,
      error: "",
      prependVersion: 0,
    };
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [
        { ...message(101, "current"), scope_type: "private" as const, scope_id: "7" },
      ],
      messageSyncCursors: {
        "private:7": { afterId: "101", revision: 4, resetRevision: 0 },
      },
      messageHistory: { "private:7": initialHistory },
    });

    const first = loadOlderMessages(store, "private", "7");
    await Promise.resolve();
    store.dispatch({
      type: "SET_MESSAGE_HISTORY",
      payload: { key: "private:7", history: initialHistory },
    });
    const second = loadOlderMessages(store, "private", "7");
    await Promise.resolve();

    resolvers[0]?.(response(200, {
      mode: "history",
      messages: [{ ...message(99, "superseded"), scope_type: "private", scope_id: "7" }],
      message_revision: 4,
      reset_revision: 0,
      has_more_before: false,
      next_before_id: null,
    }));
    await first;
    expect(store.getState().messageHistory["private:7"]?.loading).toBe(true);
    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([101]);

    resolvers[1]?.(response(200, {
      mode: "history",
      messages: [{ ...message(100, "successor"), scope_type: "private", scope_id: "7" }],
      message_revision: 4,
      reset_revision: 0,
      has_more_before: false,
      next_before_id: null,
    }));
    await second;
    expect(store.getState().messageHistory["private:7"]?.loading).toBe(false);
    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([100, 101]);
  });

  it("discards an older history page after a destructive conversation reset", async () => {
    let resolveHistory!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolveHistory = resolve;
    })));
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [
        { ...message(101, "current"), scope_type: "private" as const, scope_id: "7" },
      ],
      messageSyncCursors: {
        "private:7": { afterId: "101", revision: 4, resetRevision: 0 },
      },
      messageHistory: {
        "private:7": {
          nextBeforeId: "101",
          hasMore: true,
          loading: false,
          error: "",
          prependVersion: 0,
        },
      },
    });

    const pending = loadOlderMessages(store, "private", "7");
    await Promise.resolve();
    store.dispatch({
      type: "SET_PRIVATE_MESSAGES",
      payload: [{ ...message(200, "after reset"), scope_type: "private", scope_id: "7" }],
    });
    store.dispatch({
      type: "SET_MESSAGE_SYNC_CURSOR",
      payload: {
        key: "private:7",
        cursor: { afterId: "200", revision: 5, resetRevision: 5 },
      },
    });
    store.dispatch({
      type: "SET_MESSAGE_HISTORY",
      payload: {
        key: "private:7",
        history: {
          nextBeforeId: null,
          hasMore: false,
          loading: false,
          error: "",
          prependVersion: 0,
        },
      },
    });
    resolveHistory(response(200, {
      mode: "history",
      messages: [{ ...message(99, "stale"), scope_type: "private", scope_id: "7" }],
      message_revision: 4,
      reset_revision: 0,
      has_more_before: false,
      next_before_id: null,
    }));
    await pending;

    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([200]);
    expect(store.getState().messageSyncCursors["private:7"]?.resetRevision).toBe(5);
    expect(store.getState().messageHistory["private:7"]).toMatchObject({
      hasMore: false,
      loading: false,
      prependVersion: 0,
    });
  });

  it("coalesces a revision event received while an older refresh is in flight", async () => {
    let resolveFirst!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn((_path: string) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<ReturnType<typeof response>>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(response(200, {
        mode: "delta",
        message_revision: 5,
        messages: [{ ...message(11, "new"), scope_type: "private", scope_id: "7" }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [{ ...message(10, "current"), scope_type: "private", scope_id: "7" }],
      messageSyncCursors: { "private:7": { afterId: "10", revision: 4 } },
    });

    const first = refreshActiveChat(store);
    await Promise.resolve();
    const coalesced = refreshActiveChat(store, { authoritativeStatus: false });
    await coalesced;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(response(200, {
      mode: "delta",
      message_revision: 4,
      messages: [],
    }));
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(store.getState().messageSyncCursors["private:7"]?.revision).toBe(5);
      const messages = store.getState().privateMessages;
      expect(messages[messages.length - 1]?.id).toBe(11);
    });
  });

  it("does not let an older watchdog response roll back a realtime status", async () => {
    let resolveRead!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolveRead = resolve;
    })));
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      privateMessages: [{ ...message(10, "current"), scope_type: "private", scope_id: "7" }],
      messageSyncCursors: { "private:7": { afterId: "10", revision: 4 } },
    });

    const refresh = refreshActiveChat(store);
    await Promise.resolve();
    expect(applyScopeRealtimeUpdate(store, "private", "7", {
      message_revision: 4,
      latest_message_id: 10,
      agent_status: { state: "replying", updated_at: 100 },
    })).toBe(false);

    resolveRead(response(200, {
      mode: "delta",
      message_revision: 5,
      next_after_id: 11,
      messages: [
        { ...message(11, "arrived during status streaming"), scope_type: "private", scope_id: "7" },
      ],
      agent_status: { state: "idle", updated_at: 100 },
    }));
    await refresh;

    expect(store.getState().agentStatuses.private?.state).toBe("replying");
    expect(store.getState().privateMessages.map((item) => item.id)).toEqual([10, 11]);
    expect(store.getState().messageSyncCursors["private:7"]).toEqual({
      afterId: "11",
      revision: 5,
    });
  });

  it("restores each channel immediately and never shows the previous channel while loading", async () => {
    const responses: Array<(value: ReturnType<typeof response>) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      responses.push(resolve);
    })));
    const channelOne = message(1, "channel one");
    const channelTwo = { ...message(2, "channel two"), scope_id: "2" };
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "channel",
      activeChannelId: 1,
      channels: [{ id: 1, name: "one" }, { id: 2, name: "two" }],
      messages: [channelOne],
    });

    const toTwo = selectChannel(store, 2);
    expect(store.getState().messages).toEqual([]);
    responses.shift()?.(response(200, { messages: [channelTwo], message_revision: 2 }));
    await toTwo;

    const toOne = selectChannel(store, 1);
    expect(store.getState().messages).toEqual([channelOne]);
    responses.shift()?.(response(200, { messages: [channelOne], message_revision: 1 }));
    await toOne;
  });

  it("retains 200 cached channel messages when leaving and returning", async () => {
    const channelOne = Array.from({ length: 200 }, (_, index) => message(index + 1, `one ${index}`));
    const channelTwo = { ...message(300, "channel two"), scope_id: "2" };
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/channels/2/messages") {
        return response(200, {
          mode: "full",
          messages: [channelTwo],
          message_revision: 300,
          reset_revision: 0,
        });
      }
      if (path === "/api/channels/1/messages?after_id=200&since_revision=200") {
        return response(200, {
          mode: "delta",
          messages: [],
          next_after_id: 200,
          message_revision: 200,
          reset_revision: 0,
        });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "channel",
      activeChannelId: 1,
      channels: [{ id: 1, name: "one" }, { id: 2, name: "two" }],
      messages: channelOne,
      messageSyncCursors: {
        "channel:1": { afterId: "200", revision: 200, resetRevision: 0 },
      },
      messageHistory: {
        "channel:1": {
          nextBeforeId: null,
          hasMore: false,
          loading: false,
          error: "",
          prependVersion: 1,
        },
      },
    });

    await selectChannel(store, 2);
    const returning = selectChannel(store, 1);
    expect(store.getState().messages).toHaveLength(200);
    expect(store.getState().messages[0]?.id).toBe(1);
    await returning;

    expect(store.getState().messages).toHaveLength(200);
    expect(store.getState().messages[0]?.id).toBe(1);
    expect(store.getState().messages[199]?.id).toBe(200);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/channels/2/messages",
      "/api/channels/1/messages?after_id=200&since_revision=200",
    ]);
  });

  it("retains 200 cached private messages when leaving and returning", async () => {
    const privateMessages = Array.from({ length: 200 }, (_, index) => ({
      ...message(index + 1, `private ${index}`),
      scope_type: "private" as const,
      scope_id: "7",
    }));
    const channelMessage = { ...message(300, "channel two"), scope_id: "2" };
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/channels/2/messages") {
        return response(200, {
          mode: "full",
          messages: [channelMessage],
          message_revision: 300,
          reset_revision: 0,
        });
      }
      if (path === "/api/private-agent/messages?after_id=200&since_revision=200") {
        return response(200, {
          mode: "delta",
          messages: [],
          next_after_id: 200,
          message_revision: 200,
          reset_revision: 0,
        });
      }
      if (path === "/api/private-agent/telegram") {
        return response(200, { telegram: null });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "private",
      activeChannelId: 2,
      channels: [{ id: 2, name: "two" }],
      privateMessages,
      messageSyncCursors: {
        "private:7": { afterId: "200", revision: 200, resetRevision: 0 },
      },
      messageHistory: {
        "private:7": {
          nextBeforeId: null,
          hasMore: false,
          loading: false,
          error: "",
          prependVersion: 1,
        },
      },
    });

    await selectChannel(store, 2);
    const returning = navigateToView(store, "private");
    expect(store.getState().privateMessages).toHaveLength(200);
    expect(store.getState().privateMessages[0]?.id).toBe(1);
    await returning;

    expect(store.getState().privateMessages).toHaveLength(200);
    expect(store.getState().privateMessages[0]?.id).toBe(1);
    expect(store.getState().privateMessages[199]?.id).toBe(200);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/channels/2/messages",
      "/api/private-agent/messages?after_id=200&since_revision=200",
      "/api/private-agent/telegram",
    ]);
  });
});
