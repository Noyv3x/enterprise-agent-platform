// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTerminalPreviews } from "../../data/previewActions";
import type { AgentPreviewScope } from "../../types";
import { useTerminalPreviews } from "./useTerminalPreviews";

vi.mock("../../data/previewActions", () => ({ fetchTerminalPreviews: vi.fn() }));

const fetchPreviewsMock = vi.mocked(fetchTerminalPreviews);
const scope = { scope_type: "channel", scope_id: "4" } as const;

describe("useTerminalPreviews", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchPreviewsMock.mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains terminal data after a conditional 304 refresh", async () => {
    fetchPreviewsMock
      .mockResolvedValueOnce({
        kind: "snapshot",
        etag: '"terminal-one"',
        capturedAt: "1784060400000",
        processes: [{ id: "term-1", output: "ready\n", running: true }],
      })
      .mockResolvedValueOnce({ kind: "unchanged" });

    const { result } = renderHook(() => useTerminalPreviews(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.state.processes).toEqual([
      { id: "term-1", output: "ready\n", running: true },
    ]);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.state.processes[0]?.output).toBe("ready\n");
    expect(fetchPreviewsMock.mock.calls[1]?.[1]).toBe('"terminal-one"');
  });

  it("clears the old terminal list immediately when the Agent scope changes", async () => {
    fetchPreviewsMock
      .mockResolvedValueOnce({
        kind: "snapshot",
        etag: '"one"',
        processes: [{ id: "term-channel", output: "channel", running: true }],
      })
      .mockResolvedValueOnce({ kind: "unchanged" });
    const initialScope: AgentPreviewScope = scope;
    const { result, rerender } = renderHook(
      ({ currentScope }) => useTerminalPreviews(currentScope),
      { initialProps: { currentScope: initialScope } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.state.processes).toHaveLength(1);

    rerender({ currentScope: { scope_type: "private", scope_id: "7" } });
    expect(result.current.state.processes).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchPreviewsMock.mock.calls[1]?.[1]).toBe("");
  });
});
