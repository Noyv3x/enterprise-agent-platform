import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { Message, User } from "../types";
import {
  applyScopeRealtimeUpdate,
  refreshActiveChat,
  selectChannel,
} from "./chatActions";

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

  it("keeps the incremental chat window bounded to the latest 100 messages", async () => {
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

    const bounded = store.getState().privateMessages;
    expect(bounded).toHaveLength(100);
    expect(bounded[0]?.id).toBe(11);
    expect(bounded[bounded.length - 1]?.id).toBe(110);
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
});
