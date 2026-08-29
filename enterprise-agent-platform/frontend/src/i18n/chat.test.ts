import { describe, expect, it } from "vitest";
import { hasAgentProcessSteps } from "../components/chat/AgentWorkCard";
import { agentStatusText } from "../store/selectors";
import type { AgentStatus } from "../types";
import { translate, type Translator } from ".";

const english: Translator = (key, params) => translate("en", key, params);

describe("chat translations", () => {
  it("uses English plural forms for interface counts", () => {
    expect(translate("en", "nav.topbar.channelMessages", { count: 1 })).toBe("1 message");
    expect(translate("en", "nav.topbar.channelMessages", { count: 2 })).toBe("2 messages");
    expect(translate("en", "chat.work.records", { count: 1 })).toBe("1 work record");
    expect(translate("en", "chat.work.records", { count: 3 })).toBe("3 work records");
  });

  it("localizes structured Agent state while preserving the user name", () => {
    const status: AgentStatus = {
      state: "queued",
      replying_to: { username: "Alice" },
    };
    expect(agentStatusText(status, english)).toBe("Agent is preparing a reply to Alice");
  });

  it("does not create work records for lifecycle or approval activity without tools", () => {
    const status: AgentStatus = {
      state: "replying",
      activity: [
        { source: "platform", stage: "queued" },
        { source: "platform", stage: "replying" },
        { source: "agent", stage: "approval", detail: "Run a command" },
        { source: "agent", stage: "approval", tool: "terminal", detail: "Not a tool event" },
        { source: "platform", stage: "approval.responded", approval_choice: "once" },
        { source: "platform", stage: "complete" },
      ],
    };

    expect(hasAgentProcessSteps(status)).toBe(false);
  });

  it("keeps internal learning-review lifecycle events out of work records", () => {
    const status: AgentStatus = {
      state: "replying",
      activity: [
        { source: "platform", stage: "learning.review.queued" },
        { source: "agent", stage: "learning.review.started", tool: "memory" },
        { source: "agent", stage: "learning.review.completed", tool: "skill" },
      ],
    };

    expect(hasAgentProcessSteps(status)).toBe(false);
  });
});
