import { describe, expect, it } from "vitest";
import { terminalProcessRunning } from "./TerminalPreviewView";

describe("terminalProcessRunning", () => {
  it("treats both cancelled spellings and completed states as finished", () => {
    for (const status of ["cancelled", "canceled", "completed", "failed", "closed"]) {
      expect(terminalProcessRunning({ id: status, status })).toBe(false);
    }
  });

  it("prefers an explicit running flag", () => {
    expect(terminalProcessRunning({ id: "one", status: "cancelled", running: true })).toBe(true);
    expect(terminalProcessRunning({ id: "two", status: "running", running: false })).toBe(false);
  });
});
