import { describe, expect, it } from "vitest";
import type { AgentStatus, Message } from "../../types";
import { deriveComputerSurface, isHtmlAttachment, latestComputerStep } from "./computer";

const idleAvailability = {
  browserActive: false,
  runningTerminalCount: 0,
  presentAvailable: false,
  loading: false,
  error: "",
};

describe("computer surface derivation", () => {
  it("hides the monitor on an idle empty chat", () => {
    expect(deriveComputerSurface({
      status: { state: "idle" },
      messages: [],
      availability: idleAvailability,
    }).visible).toBe(false);
  });

  it("shows a skeleton as soon as a computer tool starts", () => {
    const status: AgentStatus = {
      state: "replying",
      activity: [{
        stage: "tool",
        tool: "write_file",
        tool_call_id: "w1",
        tool_status: "running",
        sequence: 1,
        parameters: { path: "notes.md", workspace_path: "notes.md", target: "sandbox" },
      }],
    };
    const surface = deriveComputerSurface({
      status,
      messages: [],
      availability: { ...idleAvailability, loading: true },
    });
    expect(surface.visible).toBe(true);
    expect(surface.live).toBe(true);
    expect(surface.mode).toBe("file");
    expect(latestComputerStep(status)?.tool).toBe("write_file");
  });

  it("switches an HTML write to present mode", () => {
    const surface = deriveComputerSurface({
      status: {
        state: "replying",
        activity: [{
          stage: "tool",
          tool: "write_file",
          tool_status: "completed",
          sequence: 2,
          parameters: { workspace_path: "deck.html", target: "sandbox" },
        }],
      },
      messages: [],
      availability: idleAvailability,
    });
    expect(surface.mode).toBe("present");
    expect(surface.present).toMatchObject({
      workspace_path: "deck.html",
      status: "completed",
    });
  });

  it("keeps the current running HTML write as a pending present surface", () => {
    const surface = deriveComputerSurface({
      status: {
        state: "replying",
        activity: [{
          stage: "tool",
          tool: "write_file",
          tool_call_id: "html-running",
          tool_status: "running",
          sequence: 3,
          parameters: { workspace_path: "page.html", target: "sandbox" },
        }],
      },
      messages: [],
      availability: idleAvailability,
    });

    expect(surface.mode).toBe("present");
    expect(surface.present).toMatchObject({
      workspace_path: "page.html",
      status: "running",
    });
  });

  it("advances the file revision when a same-path tool lifecycle completes", () => {
    const status = (toolStatus: "running" | "completed", updatedSequence: number): AgentStatus => ({
      state: "replying",
      activity: [{
        stage: "tool",
        tool: "write_file",
        tool_call_id: "write-1",
        tool_status: toolStatus,
        sequence: 4,
        updated_sequence: updatedSequence,
        parameters: { path: "notes.md", workspace_path: "notes.md", target: "sandbox" },
      }],
    });
    const started = deriveComputerSurface({
      status: status("running", 4),
      messages: [],
      availability: idleAvailability,
    });
    const completed = deriveComputerSurface({
      status: status("completed", 5),
      messages: [],
      availability: idleAvailability,
    });

    expect(started.file?.workspace_path).toBe("notes.md");
    expect(started.file?.status).toBe("running");
    expect(completed.file?.status).toBe("completed");
    expect(completed.file?.revision).not.toBe(started.file?.revision);
  });

  it("keeps a present page after the run when the server still has one", () => {
    const messages: Message[] = [{
      id: 9,
      author_type: "agent",
      attachments: [{ id: 3, filename: "page.html", mime_type: "text/html", url: "/api/attachments/3" }],
      metadata: { agent_work: { state: "complete", activity: [] } },
    }];
    expect(isHtmlAttachment(messages[0]?.attachments?.[0])).toBe(true);
    const surface = deriveComputerSurface({
      status: { state: "idle" },
      messages,
      availability: { ...idleAvailability, presentAvailable: true },
    });
    expect(surface.visible).toBe(true);
    expect(surface.mode).toBe("present");
  });

  it("does not keep a five-minute dead browser after idle", () => {
    const messages: Message[] = [{
      id: 1,
      author_type: "agent",
      content: "done",
      metadata: {
        agent_work: {
          state: "complete",
          activity: [{ stage: "tool", tool: "browser", tool_status: "completed" }],
        },
      },
    }];
    expect(deriveComputerSurface({
      status: { state: "idle" },
      messages,
      availability: idleAvailability,
    }).visible).toBe(false);
  });

  it("does not replace a new unavailable browser with a stale historical present page", () => {
    const messages: Message[] = [{
      id: 12,
      author_type: "agent",
      attachments: [{
        id: 8,
        filename: "old-page.html",
        mime_type: "text/html",
        url: "/api/attachments/8",
      }],
      metadata: { agent_work: { state: "complete", activity: [] } },
    }];
    const surface = deriveComputerSurface({
      status: {
        state: "replying",
        activity: [{
          stage: "tool",
          tool: "browser",
          tool_call_id: "browser-new",
          tool_status: "running",
          sequence: 20,
        }],
      },
      messages,
      availability: idleAvailability,
    });

    expect(surface.visible).toBe(true);
    expect(surface.live).toBe(true);
    expect(surface.mode).toBe("browser");
    expect(surface.present).toBeNull();
  });
});
