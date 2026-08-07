import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { Message, PostMessageResponse, User } from "../types";
import { refreshActiveChat, sendMessage, withdrawChannelMessage } from "./chatActions";

class FakeUploadRequest {
  static instances: FakeUploadRequest[] = [];
  readonly upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  timeout = -1;
  withCredentials = false;
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { FakeUploadRequest.instances.push(this); }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() { this.onabort?.(); }
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function savedMessage(id: number, content: string): Message {
  return {
    id,
    scope_type: "private",
    scope_id: "7",
    author_type: "user",
    user_id: 7,
    username: "Alice",
    content,
    created_at: id,
  };
}

function result(id: number, content: string, count: number): PostMessageResponse {
  return {
    user_message: savedMessage(id, content),
    processing_mode: count === 1 ? "started" : "joined",
    input_group_id: "agent:job-1",
    agent_status: {
      state: "replying",
      input_group_id: "agent:job-1",
      processing_mode: count === 1 ? "started" : "joined",
      active_input_group: {
        id: "agent:job-1",
        message_count: count,
      },
    },
  };
}

function privateStore() {
  const user = {
    id: 7,
    username: "alice",
    display_name: "Alice",
    active: true,
    permissions: ["private_agent"],
  } as User;
  const store = createStore(rootReducer, {
    ...initialAppState,
    user,
    activeView: "private" as const,
  });
  return store;
}

function channelStore(messages: Message[]) {
  const user = {
    id: 7,
    username: "alice",
    display_name: "Alice",
    active: true,
    permissions: ["read_workspace", "chat"],
  } as User;
  return createStore(rootReducer, {
    ...initialAppState,
    user,
    activeView: "channel" as const,
    activeChannelId: 3,
    messages,
  });
}

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
  FakeUploadRequest.instances = [];
});

describe("channel message withdrawal", () => {
  it("removes the confirmed message and refreshes the reset boundary", async () => {
    const message: Message = {
      id: 44,
      scope_type: "channel",
      scope_id: "3",
      author_type: "user",
      user_id: 7,
      username: "Alice",
      content: "withdraw me",
    };
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return response(200, { withdrawn: true, message_id: 44 });
      }
      return response(200, {
        messages: [],
        mode: "full",
        message_revision: 2,
        reset_revision: 2,
        next_after_id: 0,
        next_before_id: null,
        has_more_before: false,
        agent_status: { state: "idle" },
        typing: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = channelStore([message]);

    await expect(withdrawChannelMessage(store, "3", 44)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/channels/3/messages/44",
      expect.objectContaining({ method: "DELETE", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/channels/3/messages",
      expect.anything(),
    );
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().messageSyncCursors["channel:3"]?.resetRevision).toBe(2);
  });

  it("keeps the message when the server rejects ownership", async () => {
    const message: Message = {
      id: 45,
      scope_type: "channel",
      scope_id: "3",
      author_type: "user",
      user_id: 7,
      username: "Alice",
      content: "keep me",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(403, { error: "only the message author can withdraw it" })),
    );
    const store = channelStore([message]);

    await expect(withdrawChannelMessage(store, "3", 45)).resolves.toBe(false);

    expect(store.getState().messages).toEqual([message]);
    expect(store.getState().error).toContain("only the message author");
  });
});

describe("private rapid-message sends", () => {
  it("shows queued, byte upload, and server processing states for an attachment", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeUploadRequest);
    const store = privateStore();
    const file = new File(["1234567890"], "note.txt", { type: "text/plain" });

    const sending = sendMessage(store, "private", "7", "with file", [file]);
    expect(store.getState().privateMessages[0]?.metadata?.upload?.state).toBe("queued");
    await vi.waitFor(() => expect(FakeUploadRequest.instances).toHaveLength(1));
    const xhr = FakeUploadRequest.instances[0];
    expect(xhr.timeout).toBe(0);

    xhr.upload.onprogress?.({
      lengthComputable: true,
      loaded: 50,
      total: 100,
    } as unknown as ProgressEvent);
    expect(store.getState().privateMessages[0]?.metadata?.upload).toMatchObject({
      state: "uploading",
      loaded: 50,
      total: 100,
      percent: 50,
    });

    xhr.upload.onload?.();
    expect(store.getState().privateMessages[0]?.metadata?.upload).toMatchObject({
      state: "processing",
      percent: 100,
    });
    xhr.status = 200;
    xhr.responseText = JSON.stringify(result(91, "with file", 1));
    xhr.onload?.();

    await expect(sending).resolves.toBe(true);
    expect(store.getState().pendingMessages).toEqual([]);
    expect(store.getState().privateMessages[0]?.id).toBe(91);
  });

  it("renders every optimistic bubble immediately but POSTs in strict FIFO order", async () => {
    const pending: Array<{
      content: string;
      resolve: (value: ReturnType<typeof response>) => void;
    }> = [];
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => {
      const content = JSON.parse(String(init?.body || "{}")).content as string;
      return new Promise<ReturnType<typeof response>>((resolve) => {
        pending.push({ content, resolve });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = privateStore();

    const first = sendMessage(store, "private", "7", "first", []);
    const second = sendMessage(store, "private", "7", "second", []);
    const third = sendMessage(store, "private", "7", "third", []);

    expect(store.getState().privateMessages.map((message) => message.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.getState().pendingMessages).toHaveLength(3);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(pending[0].content).toBe("first");

    pending[0].resolve(response(200, result(101, "first", 1)));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(pending[1].content).toBe("second");
    expect(store.getState().privateMessages.map((message) => message.content)).toEqual([
      "first",
      "second",
      "third",
    ]);

    pending[1].resolve(response(200, result(102, "second", 2)));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(pending[2].content).toBe("third");
    pending[2].resolve(response(200, result(103, "third", 3)));

    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true]);
    expect(store.getState().privateMessages.map((message) => message.id)).toEqual([
      101,
      102,
      103,
    ]);
    expect(store.getState().pendingMessages).toEqual([]);
    expect(store.getState().agentStatuses.private?.active_input_group?.message_count).toBe(3);
  });

  it("continues the FIFO after a failed POST", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        calls += 1;
        const content = JSON.parse(String(init?.body || "{}")).content as string;
        return calls === 1
          ? response(503, { error: "temporarily unavailable" })
          : response(200, result(202, content, 1));
      }),
    );
    const store = privateStore();

    const first = sendMessage(store, "private", "7", "first", []);
    const second = sendMessage(store, "private", "7", "second", []);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(store.getState().privateMessages.map((message) => message.content)).toEqual(["second"]);
  });

  it("does not let an older POST response roll back newer SSE status", async () => {
    let resolvePost!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            resolvePost = resolve;
          }),
      ),
    );
    const store = privateStore();
    const sending = sendMessage(store, "private", "7", "latest detail", []);
    await vi.waitFor(() => expect(resolvePost).toBeTypeOf("function"));
    store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: {
        mode: "private",
        scopeId: "7",
        status: {
          run_id: "run-1",
          state: "approval",
          updated_at: 200,
          input_group_id: "agent:job-1",
          active_input_group: { id: "agent:job-1", message_count: 3 },
          stream_message: { content: "newer draft", updated_at: 200 },
        },
      },
    });
    const stale = result(401, "latest detail", 1);
    stale.agent_status = {
      ...stale.agent_status,
      run_id: "run-1",
      updated_at: 100,
    };
    resolvePost(response(200, stale));

    await expect(sending).resolves.toBe(true);
    expect(store.getState().agentStatuses.private?.state).toBe("approval");
    expect(store.getState().agentStatuses.private?.active_input_group?.message_count).toBe(3);
    expect(store.getState().agentStatuses.private?.stream_message?.content).toBe("newer draft");
  });

  it("drops queued sends at a session boundary", async () => {
    let resolveFirst!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = privateStore();

    const first = sendMessage(store, "private", "7", "first", []);
    const second = sendMessage(store, "private", "7", "second", []);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    resetApiSession();
    store.dispatch({ type: "RESET_SESSION" });
    resolveFirst(response(200, result(301, "first", 1)));

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getState().privateMessages).toEqual([]);
  });

  it("fences a same-second GET issued before a POST and accepts the next current read", async () => {
    let resolveOldGet!: (value: ReturnType<typeof response>) => void;
    let messageReads = 0;
    const oldStatus = {
      run_id: "run-1",
      state: "replying" as const,
      updated_at: 200,
      input_group_id: "agent:job-1",
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 3,
      },
      stream_message: { content: "obsolete draft", updated_at: 200 },
    };
    const postStatus = {
      ...oldStatus,
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 2,
      },
      stream_message: null,
      stream_messages: [],
    };
    const nextStatus = {
      ...postStatus,
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 1,
      },
    };
    const saved = savedMessage(501, "correction");

    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path.endsWith("/telegram")) return Promise.resolve(response(200, {}));
        if ((init?.method || "GET") === "POST") {
          return Promise.resolve(
            response(200, {
              user_message: saved,
              agent_status: postStatus,
              processing_mode: "joined",
              input_group_id: "agent:job-1",
            }),
          );
        }
        messageReads += 1;
        if (messageReads === 1) {
          return new Promise<ReturnType<typeof response>>((resolve) => {
            resolveOldGet = resolve;
          });
        }
        return Promise.resolve(
          response(200, { messages: [saved], agent_status: nextStatus }),
        );
      }),
    );
    const store = privateStore();
    store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "private", scopeId: "7", status: oldStatus },
    });

    const staleRead = refreshActiveChat(store);
    await vi.waitFor(() => expect(resolveOldGet).toBeTypeOf("function"));
    await expect(sendMessage(store, "private", "7", "correction", [])).resolves.toBe(true);
    expect(store.getState().agentStatuses.private?.stream_message).toBeNull();
    expect(store.getState().agentStatuses.private?.active_input_group?.message_count).toBe(2);

    resolveOldGet(response(200, { messages: [], agent_status: oldStatus }));
    await staleRead;
    expect(store.getState().privateMessages.map((message) => message.id)).toEqual([501]);
    expect(store.getState().agentStatuses.private?.stream_message).toBeNull();
    expect(store.getState().agentStatuses.private?.active_input_group?.message_count).toBe(2);

    await refreshActiveChat(store);
    expect(store.getState().agentStatuses.private).toEqual(nextStatus);
    expect(store.getState().agentStatuses.private?.active_input_group?.message_count).toBe(1);
  });
});
