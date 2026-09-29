import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { messageFingerprintKey } from "./fingerprint";

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

  it("observes streaming flags", () => {
    const streaming = messageFingerprintKey({
      ...base,
      metadata: { streaming: true },
    });
    const complete = messageFingerprintKey({
      ...base,
      metadata: {
        streaming: false,
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

  it("observes tool evidence added without changing the lifecycle summary", () => {
    const work = {
      state: "complete" as const,
      activity: [{
        stage: "tool",
        tool: "terminal",
        tool_call_id: "terminal-1",
        tool_status: "completed",
        parameters: { command: "npm test" },
      }],
    };
    const before = messageFingerprintKey({ ...base, metadata: { agent_work: work } });
    const after = messageFingerprintKey({
      ...base,
      metadata: {
        agent_work: {
          ...work,
          activity: [{ ...work.activity[0], result: "42 passed" }],
        },
      },
    });
    expect(after).not.toBe(before);
  });
});

