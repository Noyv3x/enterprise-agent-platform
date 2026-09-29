import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../../types";
import { deriveComputerSurface, latestComputerStep } from "./computer";

const idleAvailability = {
  browserActive: false,
  runningTerminalCount: 0,
  presentAvailable: false,
  loading: false,
  error: "",
};

describe("computer surface derivation", () => {
  it.each(["idle", "queued"])("hides an empty computer while %s", (state) => {
    expect(deriveComputerSurface({
      status: { state },
      availability: idleAvailability,
    }).visible).toBe(false);
  });

  it.each(["replying", "approval"])("shows waiting work while %s without inventing a screen", (state) => {
    const surface = deriveComputerSurface({
      status: { state, run_id: "run-waiting", started_at: 1_784_376_000 },
      availability: { ...idleAvailability, loading: true },
    });

    expect(surface.visible).toBe(true);
    expect(surface.live).toBe(true);
    expect(surface.mode).toBeNull();
    expect(surface.file).toBeNull();
    expect(surface.present).toBeNull();
    expect(surface.searchHits).toEqual([]);
  });

  it("keeps waiting work visible when availability fails before the first tool", () => {
    const surface = deriveComputerSurface({
      status: { state: "replying", run_id: "run-waiting" },
      availability: { ...idleAvailability, error: "Preview service unavailable" },
    });

    expect(surface.visible).toBe(true);
    expect(surface.live).toBe(true);
    expect(surface.mode).toBeNull();
    expect(surface.startedAt).toBeNull();
  });

  it("shows a skeleton as soon as a computer tool starts", () => {
    const status: AgentStatus = {
      run_id: "run-computer-1",
      started_at: 1_784_376_000,
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
      availability: { ...idleAvailability, loading: true },
    });
    expect(surface.visible).toBe(true);
    expect(surface.live).toBe(true);
    expect(surface.runId).toBe("run-computer-1");
    expect(surface.startedAt).toBe(1_784_376_000);
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
      availability: idleAvailability,
    });
    expect(surface.mode).toBe("present");
    expect(surface.present).toMatchObject({
      workspace_path: "deck.html",
      status: "completed",
    });
  });

  it("keeps an uncommitted HTML draft in file mode until the tool settles", () => {
    const surface = deriveComputerSurface({
      status: {
        run_id: "run-draft-1",
        started_at: 1_784_376_010,
        state: "replying",
        computer: {
          mode: "file",
          file: {
            tool: "write_file",
            workspace_path: "page.html",
            target: "sandbox",
            source: "draft",
            draft_kind: "file",
            status: "drafting",
            done: false,
          },
        },
      },
      availability: idleAvailability,
    });

    expect(surface.mode).toBe("file");
    expect(surface.file).toMatchObject({
      workspace_path: "page.html",
      source: "draft",
      draft_kind: "file",
      done: false,
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
      availability: idleAvailability,
    });

    expect(surface.mode).toBe("present");
    expect(surface.present).toMatchObject({
      workspace_path: "page.html",
      status: "running",
    });
  });

  it.each([
    { mode: "browser", browserActive: true, runningTerminalCount: 0 },
    { mode: "terminal", browserActive: false, runningTerminalCount: 1 },
  ])("retains an available $mode after the Run without treating it as live work", ({
    mode,
    browserActive,
    runningTerminalCount,
  }) => {
    const surface = deriveComputerSurface({
      status: { state: "idle", run_id: "finished-run", started_at: 1_784_376_000 },
      availability: { ...idleAvailability, browserActive, runningTerminalCount },
    });

    expect(surface.visible).toBe(true);
    expect(surface.mode).toBe(mode);
    expect(surface.live).toBe(false);
  });

  it("hides a completed file screen when its Run ends without retained resources", () => {
    const status: AgentStatus = {
      state: "replying",
      run_id: "finished-file-run",
      computer: {
        mode: "file",
        file: { workspace_path: "notes.md", target: "sandbox", status: "completed" },
      },
    };
    expect(deriveComputerSurface({
      status,
      availability: idleAvailability,
    }).visible).toBe(true);
    expect(deriveComputerSurface({
      status: { ...status, state: "idle" },
      availability: idleAvailability,
    }).visible).toBe(false);
  });

});
