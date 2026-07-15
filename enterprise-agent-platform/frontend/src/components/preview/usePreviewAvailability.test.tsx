// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPreviewAvailability,
  type PreviewAvailabilityResult,
} from "../../data/previewActions";
import type { AgentPreviewScope } from "../../types";
import { usePreviewAvailability } from "./usePreviewAvailability";

vi.mock("../../data/previewActions", () => ({ fetchPreviewAvailability: vi.fn() }));

const fetchAvailabilityMock = vi.mocked(fetchPreviewAvailability);
const scope = { scope_type: "private", scope_id: "7" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("usePreviewAvailability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchAvailabilityMock.mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls every two seconds and retains availability after a 304", async () => {
    fetchAvailabilityMock
      .mockResolvedValueOnce({
        kind: "snapshot",
        etag: '"status-1"',
        browserActive: true,
        runningTerminalCount: 2,
      })
      .mockResolvedValueOnce({ kind: "unchanged" });

    const { result } = renderHook(() => usePreviewAvailability(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.state).toEqual({
      browserActive: true,
      runningTerminalCount: 2,
      loading: false,
      error: "",
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.state.browserActive).toBe(true);
    expect(result.current.state.runningTerminalCount).toBe(2);
    expect(fetchAvailabilityMock.mock.calls[1]?.[1]).toBe('"status-1"');
  });

  it("pauses while hidden, aborts the request, and refreshes when visible", async () => {
    const pending = deferred<PreviewAvailabilityResult>();
    fetchAvailabilityMock
      .mockImplementationOnce((_scope, _etag, signal) => {
        expect(signal.aborted).toBe(false);
        return pending.promise;
      })
      .mockResolvedValueOnce({
        kind: "snapshot",
        etag: '"visible"',
        browserActive: false,
        runningTerminalCount: 1,
      });

    const { result } = renderHook(() => usePreviewAvailability(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const firstSignal = fetchAvailabilityMock.mock.calls[0]?.[2];

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchAvailabilityMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchAvailabilityMock).toHaveBeenCalledTimes(2);
    expect(result.current.state.runningTerminalCount).toBe(1);

    await act(async () => {
      pending.resolve({
        kind: "snapshot",
        etag: '"stale"',
        browserActive: true,
        runningTerminalCount: 9,
      });
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({ browserActive: false, runningTerminalCount: 1 });
  });

  it("synchronously clears a previous scope and ignores its late response", async () => {
    const oldRequest = deferred<PreviewAvailabilityResult>();
    const newRequest = deferred<PreviewAvailabilityResult>();
    fetchAvailabilityMock
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);
    const initialScope: AgentPreviewScope = scope;
    const { result, rerender } = renderHook(
      ({ currentScope }) => usePreviewAvailability(currentScope),
      { initialProps: { currentScope: initialScope } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const oldSignal = fetchAvailabilityMock.mock.calls[0]?.[2];

    rerender({ currentScope: { scope_type: "channel", scope_id: "4" } });
    expect(result.current.state).toEqual({
      browserActive: false,
      runningTerminalCount: 0,
      loading: true,
      error: "",
    });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await act(async () => {
      oldRequest.resolve({
        kind: "snapshot",
        etag: '"old"',
        browserActive: true,
        runningTerminalCount: 4,
      });
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({ browserActive: false, runningTerminalCount: 0 });

    await act(async () => {
      newRequest.resolve({
        kind: "snapshot",
        etag: '"new"',
        browserActive: false,
        runningTerminalCount: 2,
      });
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({ browserActive: false, runningTerminalCount: 2 });
  });

  it("stays empty and idle without a scope", async () => {
    const { result } = renderHook(() => usePreviewAvailability(null));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.state).toEqual({
      browserActive: false,
      runningTerminalCount: 0,
      loading: false,
      error: "",
    });
    expect(fetchAvailabilityMock).not.toHaveBeenCalled();
  });
});
