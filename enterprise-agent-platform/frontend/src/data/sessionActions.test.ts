import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiSession } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import type { Message, User } from "../types";
import { logout } from "./sessionActions";

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
