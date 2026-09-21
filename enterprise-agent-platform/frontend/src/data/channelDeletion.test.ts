import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { AppState, Message, User } from "../types";
import { cacheChat, restoreCachedChat } from "./chatCache";
import { applyScopeRealtimeUpdate, deleteChannel, selectChannel, sendMessage } from "./chatActions";
import { preserveFailedSend } from "./failedSendRecovery";
import { loadChannelMessages, loadChannels, loadOlderMessages } from "./loaders";

interface TestResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function response(status: number, body: unknown): TestResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const channels = [{ id: 3, name: "remove-me" }, { id: 4, name: "keep-me" }];
const message: Message = {
  id: 31, scope_type: "channel", scope_id: "3", author_type: "user", content: "retained server history",
};

function channelStore(extra: Partial<AppState> = {}, personal = false) {
  return createStore(rootReducer, {
    ...initialAppState,
    user: {
      id: 7, username: "manager", permissions: ["read_workspace", "chat", "manage_channels", ...(personal ? ["private_agent"] : [])],
    } as User,
    activeView: "channel",
    activeChannelId: 3,
    channels,
    messages: [message],
    ...extra,
  });
}

function defaultResponse(path: string, init?: RequestInit) {
  if (init?.method === "DELETE") return response(200, { deleted: true, channel_id: 3 });
  if (path === "/api/channels") return response(200, { channels: [channels[1]] });
  if (path === "/api/private-agent/telegram") return response(200, {});
  return response(200, { messages: [], typing: [], agent_status: { state: "idle" } });
}

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
});

describe("channel removal convergence", () => {
  it("prefers personal AI, drops only the removed scope, and rejects late lists and message reads", async () => {
    const list = deferred<TestResponse>();
    const messages = deferred<TestResponse>();
    let listRead = 0;
    vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/channels" && listRead++ === 0) return list.promise;
      if (path === "/api/channels/3/messages") return messages.promise;
      return Promise.resolve(defaultResponse(path, init));
    }));
    const store = channelStore({
      drafts: { "channel:3": "old draft", "channel:4": "keep draft", "private:7": "personal draft" },
      failedSends: { "channel:3": [{ id: "failed", content: "old failed send", files: [] }] },
      agentStatuses: { private: null, channels: { "3": { state: "replying" }, "4": { state: "idle" } } },
      resourceStates: {
        "chat:channel:3": { status: "loading", error: "", updatedAt: null },
        "chat:channel:4": { status: "ready", error: "", updatedAt: 10 },
      },
    }, true);
    cacheChat(store, "channel", "3", [message]);
    cacheChat(store, "channel", "4", [{ ...message, id: 41, scope_id: "4" }]);
    const oldList = loadChannels(store);
    const oldMessages = loadChannelMessages(store);

    await expect(deleteChannel(store, 3)).resolves.toBe(true);
    list.resolve(response(200, { channels }));
    messages.resolve(response(200, { messages: [message], typing: [{ user_id: 7 }], agent_status: { state: "replying" } }));
    await Promise.all([oldList, oldMessages]);

    expect(store.getState().activeView).toBe("private");
    expect(store.getState().channels).toEqual([channels[1]]);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().typingUsers).toEqual([]);
    expect(store.getState().drafts).toEqual({ "channel:4": "keep draft", "private:7": "personal draft" });
    expect(store.getState().failedSends["channel:3"]).toBeUndefined();
    expect(store.getState().agentStatuses.channels).toEqual({ "4": { state: "idle" } });
    expect(store.getState().resourceStates["chat:channel:3"]).toBeUndefined();
    expect(store.getState().resourceStates["chat:channel:4"]?.updatedAt).toBe(10);
    expect(restoreCachedChat(store, "channel", "3")).toBe(false);
    expect(restoreCachedChat(store, "channel", "4")).toBe(true);
    expect(store.getState().messages[0]?.scope_id).toBe("4");
    expect(applyScopeRealtimeUpdate(store, "channel", "3", { agent_status: { state: "replying" } })).toBe(false);
    expect(store.getState().agentStatuses.channels["3"]).toBeUndefined();
  });

  it.each([
    { remaining: [channels[1]], selected: 4 },
    { remaining: [], selected: null },
  ])("falls back without personal access to selection $selected", async ({ remaining, selected }) => {
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => defaultResponse(path, init)));
    const store = channelStore({ channels: [channels[0], ...remaining] });
    await expect(deleteChannel(store, 3)).resolves.toBe(true);
    expect(store.getState().activeView).toBe("channel");
    expect(store.getState().activeChannelId).toBe(selected);
    expect(store.getState().messages).toEqual([]);
    await selectChannel(store, 3);
    expect(store.getState().activeChannelId).toBe(selected);
  });

  it("removes an inactive channel without changing the active conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => defaultResponse(path, init)));
    const keptMessage = { ...message, id: 41, scope_id: "4" };
    const store = channelStore({ activeChannelId: 4, messages: [keptMessage], drafts: { "channel:4": "keep" } });
    await expect(deleteChannel(store, 3)).resolves.toBe(true);
    expect(store.getState().activeChannelId).toBe(4);
    expect(store.getState().messages).toEqual([keptMessage]);
    expect(store.getState().drafts).toEqual({ "channel:4": "keep" });
  });

  it("keeps cleanup failure unsuccessful while reconciling archive and permits retry by captured ID", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && attempts++ === 0) return response(503, { error: "Cleanup not confirmed" });
      return defaultResponse(path, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = channelStore();
    await expect(deleteChannel(store, 3)).resolves.toBe(false);
    expect(store.getState().channels).toEqual([channels[1]]);
    expect(store.getState().activeChannelId).toBe(4);
    expect(store.getState().error).toBe("Cleanup not confirmed");
    await expect(deleteChannel(store, 3)).resolves.toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([path]) => path))
      .toEqual(["/api/channels/3", "/api/channels/3"]);
  });

  it.each(["actor", "generation"] as const)("ignores a DELETE completion after the %s changes", async (change) => {
    const pending = deferred<TestResponse>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const store = channelStore();
    const deleting = deleteChannel(store, 3);
    if (change === "actor") store.dispatch({ type: "SET_USER", payload: { ...store.getState().user!, id: 8 } });
    else resetApiSession();
    const state = store.getState();
    pending.resolve(response(200, { deleted: true, channel_id: 3 }));
    await expect(deleting).resolves.toBe(false);
    expect(store.getState()).toBe(state);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not publish fallback loader state when the actor changes after DELETE succeeds", async () => {
    const fallback = deferred<TestResponse>();
    const startedFallback = deferred<void>();
    vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/private-agent/messages") {
        startedFallback.resolve();
        return fallback.promise;
      }
      return Promise.resolve(defaultResponse(path, init));
    }));
    const store = channelStore({}, true);
    const deleting = deleteChannel(store, 3);
    await startedFallback.promise;
    store.dispatch({ type: "SET_USER", payload: { ...store.getState().user!, id: 8 } });
    const state = store.getState();
    fallback.resolve(response(200, { messages: [{ ...message, scope_type: "private", scope_id: "7" }] }));
    await expect(deleting).resolves.toBe(false);
    expect(store.getState()).toBe(state);
  });

  it("drops late send/history completions and delayed failed-send recovery after removal", async () => {
    const post = deferred<TestResponse>();
    const history = deferred<TestResponse>();
    vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return post.promise;
      if (path.includes("before_id=")) return history.promise;
      return Promise.resolve(defaultResponse(path, init));
    }));
    const store = channelStore({
      channels: [channels[0]],
      messageSyncCursors: { "channel:3": { afterId: "31", revision: 1, resetRevision: 1 } },
      messageHistory: { "channel:3": { nextBeforeId: "31", hasMore: true, loading: false, error: "", prependVersion: 0 } },
    });
    const sending = sendMessage(store, "channel", "3", "in flight", []);
    const loadingHistory = loadOlderMessages(store, "channel", "3");
    await expect(deleteChannel(store, 3)).resolves.toBe(true);
    post.resolve(response(200, { user_message: message, agent_status: { state: "replying" } }));
    history.resolve(response(200, { messages: [message], reset_revision: 1, mode: "history" }));
    await expect(sending).resolves.toBeNull();
    await loadingHistory;
    preserveFailedSend(store, "channel:3", "delayed browser handoff", []);
    expect(store.getState().pendingMessages).toEqual([]);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().messageHistory["channel:3"]).toBeUndefined();
    expect(store.getState().messageSyncCursors["channel:3"]).toBeUndefined();
    expect(store.getState().agentStatuses.channels["3"]).toBeUndefined();
    expect(store.getState().drafts["channel:3"]).toBeUndefined();
    expect(store.getState().failedSends["channel:3"]).toBeUndefined();
  });

  it("reconciles a stale non-null selection when another member refreshes the channel list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => defaultResponse(path, init)));
    const store = channelStore();
    await loadChannels(store);
    expect(store.getState().activeChannelId).toBe(4);
    expect(store.getState().messages).toEqual([]);
  });
});
