// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  compactTerminalTranscript,
  terminalDisplayProcesses,
  terminalProcessFromStep,
  terminalProcessRunning,
} from "./TerminalPreviewView";

describe("terminalProcessRunning", () => {
  it("treats protocol terminal states as finished", () => {
    for (const status of ["cancelled", "completed", "failed"] as const) {
      expect(terminalProcessRunning({ id: status, status })).toBe(false);
    }
  });

  it("prefers an explicit running flag", () => {
    expect(terminalProcessRunning({ id: "one", status: "cancelled", running: true })).toBe(true);
    expect(terminalProcessRunning({ id: "two", status: "running", running: false })).toBe(false);
  });

  it("keeps orphaned processes active even when the explicit flag is absent", () => {
    expect(terminalProcessRunning({ id: "orphaned", status: "orphaned" })).toBe(true);
  });
});

describe("terminal work-row fallback", () => {
  it("recovers the complete command, bounded output, and exit status", () => {
    expect(terminalProcessFromStep({
      tool: "terminal",
      tool_call_id: "command-7",
      tool_status: "completed",
      parameters: { command: "npm run build -- --mode production", cwd: "/workspace" },
      result: "building\ndone\n[exit 0]",
      result_truncated_chars: 120,
      at: 12,
      completed_at: 13,
    })).toEqual({
      id: "work:command-7",
      title: "npm run build -- --mode production",
      command: "npm run build -- --mode production",
      cwd: "/workspace",
      output: "building\ndone",
      status: "completed",
      running: false,
      started_at: 12,
      updated_at: 13,
      finished_at: 13,
      exit_code: 0,
      truncated: true,
    });
  });

  it("marks a non-zero command exit as failed even when the tool lifecycle completed", () => {
    expect(terminalProcessFromStep({
      tool: "terminal",
      tool_status: "completed",
      parameters: { command: "false" },
      result: "[exit 1]",
    })?.status).toBe("failed");
  });

  it("keeps a distinct short-command result ahead of unrelated live background output", () => {
    const background = {
      id: "service-1",
      command: "npm run dev",
      output: "listening",
      status: "running" as const,
      running: true,
    };
    const displayed = terminalDisplayProcesses([background], {
      tool: "terminal",
      tool_call_id: "short-1",
      tool_status: "completed",
      parameters: { command: "npm test" },
      result: "passed\n[exit 0]",
    });

    expect(displayed.map((process) => process.id)).toEqual(["work:short-1", "service-1"]);
    expect(displayed[0]?.output).toBe("passed");
  });

  it("prefers a matching live snapshot instead of duplicating its work-row fallback", () => {
    const live = {
      id: "manager-1",
      command: "npm test",
      output: "test 2/10",
      status: "running" as const,
      running: true,
    };
    expect(terminalDisplayProcesses([live], {
      tool: "terminal",
      tool_call_id: "short-1",
      tool_status: "running",
      parameters: { command: "npm test" },
    })).toEqual([live]);
  });

  it("moves a matching live snapshot ahead of an older background process", () => {
    const background = {
      id: "service-1",
      command: "npm run dev",
      status: "running" as const,
      running: true,
    };
    const matching = {
      id: "manager-2",
      command: "npm test",
      output: "test 4/10",
      status: "running" as const,
      running: true,
    };
    expect(terminalDisplayProcesses([background, matching], {
      tool: "terminal",
      tool_call_id: "short-1",
      tool_status: "running",
      parameters: { command: "npm test" },
    }).map((process) => process.id)).toEqual(["manager-2", "service-1"]);
  });

  it("uses process_id to replace and prioritize the matching live background process", () => {
    const older = {
      id: "service-older",
      command: "npm run dev",
      status: "running" as const,
      running: true,
    };
    const matching = {
      id: "service-target",
      command: "python worker.py",
      output: "job 7/20",
      status: "running" as const,
      running: true,
    };
    const fallback = {
      tool: "process",
      tool_call_id: "process-read-call",
      tool_status: "completed",
      parameters: { action: "read", process_id: "service-target" },
      result: "job 6/20",
    };

    expect(terminalProcessFromStep(fallback)?.id).toBe("work:service-target");
    const displayed = terminalDisplayProcesses([older, matching], fallback);
    expect(displayed.map((process) => process.id)).toEqual(["service-target", "service-older"]);
    expect(displayed[0]?.output).toBe("job 7/20");
  });

  it("bounds the compact preview to the latest output lines", () => {
    const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
    const transcript = compactTerminalTranscript({
      id: "tail",
      command: "run checks",
      output,
      status: "running",
    });
    expect(transcript).toContain("$ run checks");
    expect(transcript).not.toContain("line 3");
    expect(transcript).toContain("line 4");
    expect(transcript).toContain("line 8");
  });
});
