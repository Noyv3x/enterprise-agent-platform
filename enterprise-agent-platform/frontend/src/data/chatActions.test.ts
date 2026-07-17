import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { Message, PostMessageResponse, User } from "../types";
import { refreshActiveChat, sendMessage } from "./chatActions";

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

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
});

describe("private rapid-message sends", () => {
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
