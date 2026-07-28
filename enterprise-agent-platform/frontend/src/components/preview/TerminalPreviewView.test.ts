// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { terminalProcessRunning } from "./TerminalPreviewView";

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
