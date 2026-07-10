import { describe, expect, it } from "vitest";
import type { AgentStatus, Message } from "../types";
import { agentStatusFingerprint, messageFingerprintKey } from "./fingerprint";

const base: Message = {
  id: "message-1",
  author_type: "agent",
  username: "Agent",
  content: "first token",
  metadata: {},
};

describe("messageFingerprintKey", () => {
  it("changes as streamed content grows", () => {
    const before = messageFingerprintKey(base);
    const after = messageFingerprintKey({ ...base, content: "first token and second token" });
    expect(after).not.toBe(before);
  });

  it("observes streaming flags and knowledge suggestion details", () => {
    const streaming = messageFingerprintKey({
      ...base,
      metadata: { streaming: true },
    });
    const complete = messageFingerprintKey({
      ...base,
      metadata: {
        streaming: false,
        knowledge_suggestions: [
          { id: 3, title: "Runbook", summary: "Updated summary", source: "knowledge" },
        ],
      },
    });
    expect(complete).not.toBe(streaming);
  });

  it("observes attachment presentation and download targets", () => {
    const file = messageFingerprintKey({
      ...base,
      attachments: [
        {
          id: "attachment-1",
          filename: "diagram.png",
          url: "/preview/diagram.png",
          download_url: "/download/diagram.png",
          is_image: false,
        },
      ],
    });
    const image = messageFingerprintKey({
      ...base,
      attachments: [
        {
          id: "attachment-1",
          filename: "diagram.png",
          url: "/preview/diagram.png",
          download_url: "/download/diagram-v2.png",
          is_image: true,
        },
      ],
    });
    expect(image).not.toBe(file);
  });

  it("observes agent-work tool labels and fallback run identity", () => {
    const before = messageFingerprintKey({
      ...base,
      metadata: {
        agent_work: {
          state: "complete",
          started_at: 100,
          activity: [{ stage: "tool", tool: "search", emoji: "🔎" }],
        },
      },
    });
    const after = messageFingerprintKey({
      ...base,
      metadata: {
        agent_work: {
          state: "complete",
          started_at: 101,
          activity: [{ stage: "tool", tool: "browser", emoji: "🌐" }],
        },
      },
    });
    expect(after).not.toBe(before);
  });
});

describe("agentStatusFingerprint", () => {
  it("observes every stream field used to synthesize a message", () => {
    const status: AgentStatus = {
      state: "replying",
      started_at: 100,
      stream_message: {
        id: "stream-1",
        content: "working",
        updated_at: 100,
        username: "Agent One",
        created_at: 90,
        active: true,
      },
    };
    const before = agentStatusFingerprint(status);
    const after = agentStatusFingerprint({
      ...status,
      stream_message: {
        ...status.stream_message,
        username: "Agent Two",
        created_at: 91,
        active: false,
      },
    });
    expect(after).not.toEqual(before);
  });
});
