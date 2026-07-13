import { describe, expect, it, vi } from "vitest";
import { ApiRequestCancelledError } from "../lib/api";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { ensureResource, runResourceLoad } from "./resourceState";

function makeStore() {
  return createStore(rootReducer, initialAppState);
}

describe("resource request state", () => {
  it("tracks a successful load and timestamp", async () => {
    const store = makeStore();
    const load = vi.fn(async () => undefined);

    await expect(runResourceLoad(store, "knowledge:list", load)).resolves.toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(store.getState().resourceStates["knowledge:list"]).toMatchObject({
      status: "ready",
      error: "",
    });
    expect(store.getState().resourceStates["knowledge:list"].updatedAt).toEqual(expect.any(Number));
  });

  it("keeps the previous timestamp when a refresh fails", async () => {
    const store = makeStore();
    await runResourceLoad(store, "admin:accounts", async () => undefined);
    const updatedAt = store.getState().resourceStates["admin:accounts"].updatedAt;

    await expect(
      runResourceLoad(store, "admin:accounts", async () => {
        throw new Error("offline");
      }),
    ).resolves.toBe(false);
    expect(store.getState().resourceStates["admin:accounts"]).toEqual({
      status: "error",
      error: "offline",
      updatedAt,
    });
  });

  it("does not reload a ready resource until explicitly refreshed", async () => {
    const store = makeStore();
    const load = vi.fn(async () => undefined);
    await ensureResource(store, "knowledge:list", load);
    await ensureResource(store, "knowledge:list", load);
    expect(load).toHaveBeenCalledOnce();
  });

  it("deduplicates an in-flight resource load", async () => {
    const store = makeStore();
    let resolveLoad!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const first = ensureResource(store, "knowledge:search", load);
    await expect(ensureResource(store, "knowledge:search", load)).resolves.toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(store.getState().resourceStates["knowledge:search"]).toMatchObject({
      status: "loading",
      error: "",
    });

    resolveLoad();
    await expect(first).resolves.toBe(true);
    expect(store.getState().resourceStates["knowledge:search"].status).toBe("ready");
  });

  it("does not start a second explicit refresh while the first is loading", async () => {
    const store = makeStore();
    let resolveFirst!: () => void;
    const secondLoad = vi.fn(async () => undefined);
    const first = runResourceLoad(
      store,
      "admin:runtime",
      () => new Promise<void>((resolve) => { resolveFirst = resolve; }),
    );
    await expect(runResourceLoad(store, "admin:runtime", secondLoad)).resolves.toBe(false);
    expect(secondLoad).not.toHaveBeenCalled();
    resolveFirst();
    await expect(first).resolves.toBe(true);
  });

  it("clears resource ownership on a session reset", async () => {
    const store = makeStore();
    await runResourceLoad(store, "knowledge:list", async () => undefined);
    store.dispatch({ type: "RESET_SESSION" });
    expect(store.getState().resourceStates).toEqual({});
  });

  it("does not restore a cancelled old-session resource after reset", async () => {
    const store = makeStore();
    let rejectLoad!: (error: Error) => void;
    const pending = runResourceLoad(
      store,
      "knowledge:list",
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        }),
    );

    expect(store.getState().resourceStates["knowledge:list"].status).toBe("loading");
    store.dispatch({ type: "RESET_SESSION" });
    rejectLoad(new ApiRequestCancelledError());

    await expect(pending).resolves.toBe(false);
    expect(store.getState().resourceStates).toEqual({});
  });
});
