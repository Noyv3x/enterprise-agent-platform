import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { Message, User } from "../types";
import { boot, login, logout, runBusy } from "./sessionActions";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  resetApiSession();
  vi.unstubAllGlobals();
});

describe("logout", () => {
  it("clears local session state before the best-effort POST completes", async () => {
    let resolveFetch!: (value: ReturnType<typeof response>) => void;
    let requestOptions: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, options: RequestInit) => {
        requestOptions = options;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      }),
    );

    const user: User = { id: 7, username: "alice" };
    const privateMessage: Message = {
      id: 11,
      author_type: "user",
      username: "alice",
      content: "private data",
    };
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: user });
    store.dispatch({ type: "SET_PRIVATE_MESSAGES", payload: [privateMessage] });

    const completion = logout(store);

    expect(store.getState().user).toBeNull();
    expect(store.getState().privateMessages).toEqual([]);
    expect(requestOptions).toMatchObject({ method: "POST", keepalive: true });

    resolveFetch(response(200, {}));
    await expect(completion).resolves.toBeUndefined();
  });
});

describe("runBusy semantic operations", () => {
  it("does not start the same named operation twice", async () => {
    const store = createStore(rootReducer, initialAppState);
    let finish!: () => void;
    const firstFn = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const duplicateFn = vi.fn(async () => undefined);

    const first = runBusy(store, "settings:save", firstFn);
    await runBusy(store, "settings:save", duplicateFn);
    expect(firstFn).toHaveBeenCalledOnce();
    expect(duplicateFn).not.toHaveBeenCalled();
    expect(store.getState().pendingOperations).toEqual(["settings:save"]);

    finish();
    await first;
    expect(store.getState().pendingOperations).toEqual([]);
  });
});

describe("compact session bootstrap", () => {
  const bootstrap = {
    user: { id: 7, username: "alice", permissions: ["chat"] } as User,
    channels: [{ id: 4, name: "general" }],
    mention_targets: [{ handle: "bob" }],
    active_scope: { scope_type: "channel" as const, scope_id: 4 },
    messages: [{ id: 11, author_type: "user", content: "hello" }] as Message[],
    agent_status: null,
    typing: [],
    message_revision: 3,
  };

  it("boots an authenticated shell in one request", async () => {
    const fetchMock = vi.fn(async (_path: string) => response(200, bootstrap));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, initialAppState);

    await expect(boot(store)).resolves.toBe("authenticated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/session/bootstrap");
    expect(store.getState()).toMatchObject({
      user: bootstrap.user,
      activeChannelId: 4,
      messages: bootstrap.messages,
    });
    expect(store.getState().messageSyncCursors["channel:4"]).toEqual({
      afterId: "11",
      revision: 3,
    });
  });

  it("hydrates an embedded login bootstrap without follow-up reads", async () => {
    const fetchMock = vi.fn(async () => response(200, {
      user: bootstrap.user,
      bootstrap,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, initialAppState);

    await login(store, "alice", "secret");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getState().messages).toEqual(bootstrap.messages);
  });
});
