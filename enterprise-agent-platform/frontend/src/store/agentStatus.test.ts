import { describe, expect, it } from "vitest";
import { createStore } from "../lib/store";
import type { AgentStatus } from "../types";
import { initialAppState, rootReducer } from "./reducer";
import { mergeAgentStatus } from "./agentStatus";

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    run_id: "run-1",
    state: "replying",
    input_group_id: "agent:job-1",
    active_input_group: {
      id: "agent:job-1",
      state: "accepted",
      message_count: 3,
      message_ids: [11, 12, 13],
    },
    updated_at: 200,
    ...overrides,
  };
}

describe("mergeAgentStatus", () => {
  it("accepts a strictly newer legal stream clear and input-count shrink", () => {
    const current = status({
      stream_message: { id: "old", content: "obsolete draft", updated_at: 200 },
    });
    const incoming = status({
      updated_at: 201,
      queued_count: 1,
      stream_message: null,
      stream_messages: [],
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 2,
        message_ids: [11, 12],
      },
    });

    expect(mergeAgentStatus(current, incoming)).toBe(incoming);
  });

  it("rejects a truly older response even when it contains more stream text", () => {
    const current = status({
      updated_at: 202,
      stream_message: null,
      active_input_group: {
        id: "agent:job-1",
        state: "injected",
        message_count: 3,
      },
    });
    const stale = status({
      updated_at: 201,
      stream_message: { content: "obsolete draft", updated_at: 201 },
    });

    expect(mergeAgentStatus(current, stale)).toBe(current);
  });

  it("uses group progress to order same-second snapshots", () => {
    const current = status({
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 2,
      },
    });
    const injected = status({
      active_input_group: {
        id: "agent:job-1",
        state: "injected",
        message_count: 3,
      },
      stream_message: null,
    });
    const stale = status({
      active_input_group: {
        id: "agent:job-1",
        state: "reserved",
        message_count: 1,
      },
      stream_message: { content: "old", updated_at: 200 },
    });

    expect(mergeAgentStatus(current, injected)).toBe(injected);
    expect(mergeAgentStatus(injected, stale)).toBe(injected);
  });

  it("keeps an approval until an equal-second snapshot proves it was resolved", () => {
    const approval = status({
      state: "approval",
      approval: { approval_id: "approval-1" },
    });
    const staleReplying = status({ state: "replying", approval: null });
    const resolved = status({
      state: "replying",
      approval: null,
      activity: [{ stage: "approval.responded", at: 200 }],
    });

    expect(mergeAgentStatus(approval, staleReplying)).toBe(approval);
    expect(mergeAgentStatus(approval, resolved)).toBe(resolved);
  });

  it("applies the same merge policy to single-status and whole-map ingresses", () => {
    const store = createStore(rootReducer, initialAppState);
    const current = status({
      updated_at: 202,
      stream_message: null,
      active_input_group: {
        id: "agent:job-1",
        state: "injected",
        message_count: 3,
      },
    });
    store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "private", scopeId: "7", status: current },
    });
    const channel = status({ run_id: "channel-run", input_group_id: "" });
    store.dispatch({
      type: "SET_AGENT_STATUS",
      payload: { mode: "channel", scopeId: "42", status: channel },
    });
    store.dispatch({
      type: "SET_AGENT_STATUSES",
      payload: {
        channels: {},
        private: status({
          updated_at: 201,
          stream_message: { content: "stale poll response", updated_at: 201 },
        }),
      },
    });
    expect(store.getState().agentStatuses.private).toBe(current);
    expect(store.getState().agentStatuses.channels["42"]).toBe(channel);

    const newer = status({
      updated_at: 203,
      stream_message: null,
      active_input_group: {
        id: "agent:job-1",
        state: "accepted",
        message_count: 2,
      },
    });
    store.dispatch({
      type: "SET_AGENT_STATUSES",
      payload: { channels: {}, private: newer },
    });
    expect(store.getState().agentStatuses.private).toBe(newer);
  });
});
