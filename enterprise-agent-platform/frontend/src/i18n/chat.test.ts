import { describe, expect, it } from "vitest";
import { agentProcessLines } from "../components/chat/AgentWorkCard";
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

  it("localizes activity stages while preserving tool names and technical details", () => {
    const status: AgentStatus = {
      state: "replying",
      activity: [
        {
          source: "hermes",
          stage: "tool",
          tool: "enterprise_kb_search",
          detail: "VPN access policy",
          emoji: "🔍",
          tool_status: "completed",
        },
        {
          source: "hermes",
          stage: "approval",
          detail: "rm -rf /tmp/example",
        },
        {
          source: "platform",
          stage: "approval.responded",
        },
        {
          source: "platform",
          stage: "complete",
        },
      ],
    };

    expect(agentProcessLines(status, english)).toEqual([
      '✅ Completed enterprise_kb_search: "VPN access policy"',
      "🛡️ Waiting for access approval: rm -rf /tmp/example",
      "🛡️ Access approval completed",
      "✅ Work completed",
    ]);
  });
});
