import { describe, expect, it } from "vitest";
import { createStore } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { preserveFailedSend, restoreNextFailedSend } from "./failedSendRecovery";

function files(prefix: string): File[] {
  return Array.from({ length: 10 }, (_, index) => ({
    name: `${prefix}-${index}.txt`,
    size: index + 1,
    type: "text/plain",
  })) as File[];
}

describe("failed send recovery", () => {
  it("retains multiple full attachment payloads and restores them FIFO", () => {
    const store = createStore(rootReducer, initialAppState);
    const key = "private:7";
    const current = files("current").slice(0, 1);
    const first = files("first");
    const second = files("second");
    store.dispatch({ type: "SET_DRAFT", payload: { key, value: "new unsent work" } });
    store.dispatch({ type: "SET_DRAFT_FILES", payload: { key, files: current } });

    preserveFailedSend(store, key, "first failed message", first);
    preserveFailedSend(store, key, "second failed message", second);

    expect(store.getState().drafts[key]).toBe("new unsent work");
    expect(store.getState().draftFiles[key]).toBe(current);
    expect(store.getState().failedSends[key]).toHaveLength(2);
    expect(store.getState().failedSends[key]?.[0]?.files).toEqual(first);
    expect(store.getState().failedSends[key]?.[1]?.files).toEqual(second);

    store.dispatch({ type: "SET_DRAFT", payload: { key, value: "" } });
    store.dispatch({ type: "REMOVE_DRAFT_FILES", payload: { key } });
    restoreNextFailedSend(store, key);
    expect(store.getState().drafts[key]).toBe("first failed message");
    expect(store.getState().draftFiles[key]).toEqual(first);
    expect(store.getState().failedSends[key]?.[0]?.content).toBe("second failed message");

    store.dispatch({ type: "SET_DRAFT", payload: { key, value: "" } });
    store.dispatch({ type: "REMOVE_DRAFT_FILES", payload: { key } });
    restoreNextFailedSend(store, key);
    expect(store.getState().drafts[key]).toBe("second failed message");
    expect(store.getState().draftFiles[key]).toEqual(second);
    expect(store.getState().failedSends[key]).toBeUndefined();
  });

  it("clears retained payloads at a session boundary", () => {
    const store = createStore(rootReducer, initialAppState);
    preserveFailedSend(store, "private:7", "secret", files("secret"));
    store.dispatch({ type: "RESET_SESSION" });
    expect(store.getState().failedSends).toEqual({});
    expect(store.getState().draftFiles).toEqual({});
  });
});
