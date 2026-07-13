import { describe, expect, it } from "vitest";
import { agentProcessLines, hasAgentProcessSteps } from "../components/chat/AgentWorkCard";
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
          source: "agent",
          stage: "tool",
          tool: "knowledge_search",
          detail: "VPN access policy",
          emoji: "🔍",
          tool_status: "completed",
        },
        {
          source: "agent",
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
      "✅ Completed knowledge_search · VPN access policy",
    ]);
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

    expect(agentProcessLines(status, english)).toEqual([]);
    expect(hasAgentProcessSteps(status)).toBe(false);
  });

  it("compacts legacy tool noise and preserves distinct real tool calls", () => {
    const status: AgentStatus = {
      state: "replying",
      activity: [
        { source: "platform", stage: "replying" },
        { source: "platform", stage: "replying" },
        { source: "agent", stage: "tool", tool: "tool", label: "tool", detail: "tool" },
        { source: "agent", stage: "tool", tool: "tool", label: "tool", detail: "tool" },
        { source: "agent", stage: "tool.started", tool: "web", tool_call_id: "web-1" },
        {
          source: "agent",
          stage: "tool.completed",
          tool: "web",
          tool_call_id: "web-1",
          tool_status: "completed",
        },
        {
          source: "agent",
          stage: "tool.started",
          tool: "terminal",
          tool_call_id: "terminal-1",
        },
        {
          source: "platform",
          stage: "approval.responded",
          approval_id: "approval-1",
          approval_choice: "once",
        },
        {
          source: "agent",
          stage: "tool.completed",
          tool: "terminal",
          tool_call_id: "terminal-1",
          tool_status: "completed",
        },
        {
          source: "platform",
          stage: "approval.responded",
          approval_id: "approval-1",
          approval_choice: "once",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "search_files",
          tool_call_id: "search-1",
          tool_status: "completed",
          detail: "config · ./src",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "web",
          tool_call_id: "web-2",
          tool_status: "completed",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "read_file",
          tool_call_id: "read-1",
          tool_status: "failed",
          detail: "missing.txt",
        },
      ],
    };

    expect(agentProcessLines(status, english)).toEqual([
      "✅ Completed Web search",
      "✅ Completed Command",
      "✅ Completed File search · config · ./src",
      "✅ Completed Web search",
      "⚠️ Read file failed · missing.txt",
    ]);
  });
});
