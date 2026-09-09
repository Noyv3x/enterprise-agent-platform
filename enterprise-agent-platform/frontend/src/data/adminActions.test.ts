import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { AppState, User } from "../types";
import {
  deleteChannelMessage,
  deletePrivateMessage,
  refreshAuditChannel,
  selectAuditChannel,
  selectAuditConversation,
} from "./adminActions";
import { loadAuditPrivateMessages, type AppStore } from "./loaders";

const admin = { id: 7, username: "admin", role: "admin", permissions: ["admin"] } as User;

interface FetchStub {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(body: unknown, status = 200): FetchStub {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function makeStore(audit: Partial<AppState["messageAudit"]> = {}) {
  return createStore(rootReducer, {
    ...initialAppState,
    user: admin,
    messageAudit: { ...initialAppState.messageAudit, ...audit },
  });
}

function contents(store: AppStore, list: "channelMessages" | "privateMessages") {
  return store.getState().messageAudit[list].map((message) => message.content);
}

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
});

describe("message audit selection", () => {
  it("keeps the selected channel's rows when the earlier channel answers late", async () => {
    const first = deferred<FetchStub>();
    const second = deferred<FetchStub>();
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === endpoints.auditChannelMessages.path("11")) return first.promise;
        if (path === endpoints.auditChannelMessages.path("22")) return second.promise;
        throw new Error(`unexpected request ${path}`);
      }),
    );
    const store = makeStore();

    const selectFirst = selectAuditChannel(store, "11");
    const selectSecond = selectAuditChannel(store, "22");
    second.resolve(response({ messages: [{ id: 202, content: "B_ONLY" }], total: 1 }));
    await selectSecond;
    first.resolve(response({ messages: [{ id: 101, content: "A_ONLY" }], total: 1 }));
    await selectFirst;

    expect(store.getState().messageAudit.auditChannelId).toBe("22");
    expect(contents(store, "channelMessages")).toEqual(["B_ONLY"]);
    expect(store.getState().messageAudit.channelTotal).toBe(1);
  });

  it("isolates the previous conversation synchronously and lets only the newest read commit", async () => {
    const stale = deferred<FetchStub>();
    const fresh = deferred<FetchStub>();
    let bobReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === endpoints.auditPrivateMessages.path("11")) {
          return Promise.resolve(response({ messages: [{ id: 101, content: "A_ONLY" }], total: 1 }));
        }
        if (path === endpoints.auditPrivateMessages.path("22")) {
          bobReads += 1;
          return bobReads === 1 ? stale.promise : fresh.promise;
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );
    const store = makeStore();

    await selectAuditConversation(store, 11);
    expect(contents(store, "privateMessages")).toEqual(["A_ONLY"]);

    const staleSelect = selectAuditConversation(store, 22);
    // The switch drops the previous user's rows before any response arrives.
    expect(store.getState().messageAudit.auditPrivateUserId).toBe("22");
    expect(store.getState().messageAudit.privateMessages).toEqual([]);
    expect(store.getState().messageAudit.privateTotal).toBe(0);

    // A newer read for the same selection (a delete cascade or refresh) supersedes
    // the pending one even though both belong to Bob.
    const freshRead = loadAuditPrivateMessages(store, 22);
    fresh.resolve(response({ messages: [{ id: 202, content: "B_NEW" }], total: 1 }));
    await freshRead;
    stale.resolve(response({ messages: [{ id: 201, content: "B_OLD" }], total: 1 }));
    await staleSelect;

    expect(contents(store, "privateMessages")).toEqual(["B_NEW"]);
  });

  it("never re-selects a conversation the admin left when a delete reload lands", async () => {
    const conversations = deferred<FetchStub>();
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(response({ deleted: 1 }));
      if (path === endpoints.privateConversations.path()) return conversations.promise;
      if (path === endpoints.auditPrivateMessages.path("22")) {
        return Promise.resolve(response({ messages: [{ id: 202, content: "B_ONLY" }], total: 1 }));
      }
      return Promise.resolve(response({ messages: [{ id: 101, content: "A_ONLY" }], total: 1 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore({
      auditPrivateUserId: "11",
      privateMessages: [{ id: 101, author_type: "user", content: "A_ONLY" }],
      privateTotal: 1,
      privateConversations: [
        { user_id: 11, username: "alice", message_count: 1 },
        { user_id: 22, username: "bob", message_count: 1 },
      ],
    });

    const deletion = deletePrivateMessage(store, 11, 101);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(endpoints.privateConversations.path(), expect.anything()),
    );
    const switched = selectAuditConversation(store, 22);
    conversations.resolve(response({
      conversations: [
        { user_id: 11, username: "alice", message_count: 0 },
        { user_id: 22, username: "bob", message_count: 1 },
      ],
    }));
    await Promise.all([deletion, switched]);

    expect(store.getState().messageAudit.auditPrivateUserId).toBe("22");
    expect(contents(store, "privateMessages")).toEqual(["B_ONLY"]);
    expect(fetchMock).not.toHaveBeenCalledWith(
      endpoints.auditPrivateMessages.path("11"),
      expect.anything(),
    );
  });

  it("reloads a channel the admin returns to even while its earlier slow refresh is still pending", async () => {
    const slowRead = deferred<FetchStub>();
    let channelReads = 0;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(response({ deleted: 1 }));
      if (path === endpoints.channels.path()) {
        return Promise.resolve(response({ channels: [{ id: 3, name: "general" }, { id: 4, name: "random" }] }));
      }
      if (path === endpoints.auditChannelMessages.path("3")) {
        channelReads += 1;
        // The first refresh stays slow; every later read sees the post-delete list.
        return channelReads === 1
          ? slowRead.promise
          : Promise.resolve(response({ messages: [{ id: 302, content: "C_REMAINING_ROW" }], total: 1 }));
      }
      if (path === endpoints.auditChannelMessages.path("4")) {
        return Promise.resolve(response({ messages: [{ id: 401, content: "D_ONLY" }], total: 1 }));
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user: admin,
      activeChannelId: 4,
      channels: [{ id: 3, name: "general" }, { id: 4, name: "random" }],
      messageAudit: {
        ...initialAppState.messageAudit,
        auditChannelId: "3",
        channelMessages: [
          { id: 301, author_type: "user", content: "C_DELETED_ROW" },
          { id: 302, author_type: "agent", content: "C_REMAINING_ROW" },
        ],
        channelTotal: 2,
      },
    });

    // A1: a slow refresh of channel 3 stays pending for the whole scenario.
    const slowRefresh = refreshAuditChannel(store, "3");
    await vi.waitFor(() => expect(channelReads).toBe(1));

    // A2: a row delete cascades a fresh channel-3 read that completes normally.
    await deleteChannelMessage(store, "3", 301);
    expect(contents(store, "channelMessages")).toEqual(["C_REMAINING_ROW"]);

    // Switch away and back while A1 is still pending.
    await selectAuditChannel(store, "4");
    expect(contents(store, "channelMessages")).toEqual(["D_ONLY"]);
    const back = selectAuditChannel(store, "3");
    slowRead.resolve(response({
      messages: [{ id: 301, content: "C_DELETED_ROW" }, { id: 302, content: "C_REMAINING_ROW" }],
      total: 2,
    }));
    await Promise.all([slowRefresh, back]);

    // Returning to channel 3 must show its current list: neither the empty
    // isolation state nor the pre-delete rows from the slow refresh.
    expect(store.getState().messageAudit.auditChannelId).toBe("3");
    expect(contents(store, "channelMessages")).toEqual(["C_REMAINING_ROW"]);
    expect(store.getState().messageAudit.channelTotal).toBe(1);
  });
});
