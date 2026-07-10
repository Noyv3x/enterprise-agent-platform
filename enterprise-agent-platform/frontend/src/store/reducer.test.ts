import { describe, expect, it } from "vitest";
import type { Message, User } from "../types";
import { initialAppState, rootReducer } from "./reducer";

const user = {
  id: 7,
  username: "alice",
  display_name: "Alice",
  active: true,
  permissions: ["chat"],
} as User;

const message: Message = {
  id: 11,
  author_type: "user",
  user_id: user.id,
  username: user.username,
  content: "private data",
};

describe("rootReducer session boundaries", () => {
  it("clears the complete state tree on RESET_SESSION", () => {
    let state = rootReducer(initialAppState, { type: "SET_USER", payload: user });
    state = rootReducer(state, {
      type: "SET_CHANNELS",
      payload: [{ id: 4, name: "secret" }],
    });
    state = rootReducer(state, { type: "SET_PRIVATE_MESSAGES", payload: [message] });
    state = rootReducer(state, {
      type: "SET_DRAFT",
      payload: { key: "private:7", value: "unsent secret" },
    });
    state = rootReducer(state, { type: "SET_USERS", payload: [user] });
    state = rootReducer(state, { type: "BEGIN_BUSY", payload: "old-operation" });

    const reset = rootReducer(state, { type: "RESET_SESSION" });

    expect(reset).toEqual(initialAppState);
    expect(reset).not.toBe(initialAppState);
    expect(reset.user).toBeNull();
    expect(reset.privateMessages).toEqual([]);
    expect(reset.drafts).toEqual({});
    expect(reset.users).toEqual([]);
    expect(reset.pendingOperations).toEqual([]);
  });

  it("tracks overlapping operations and ignores stale completions", () => {
    let state = rootReducer(initialAppState, { type: "BEGIN_BUSY", payload: "one" });
    state = rootReducer(state, { type: "BEGIN_BUSY", payload: "two" });
    state = rootReducer(state, { type: "END_BUSY", payload: "one" });
    expect(state.busy).toBe(true);
    expect(state.pendingOperations).toEqual(["two"]);

    state = rootReducer(state, { type: "RESET_SESSION" });
    state = rootReducer(state, { type: "BEGIN_BUSY", payload: "new-session" });
    state = rootReducer(state, { type: "END_BUSY", payload: "two" });
    expect(state.busy).toBe(true);
    expect(state.pendingOperations).toEqual(["new-session"]);
  });
});
