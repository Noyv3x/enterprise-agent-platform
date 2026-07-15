// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBrowserPreview } from "../../data/previewActions";
import type { AgentPreviewScope } from "../../types";
import { useBrowserPreview } from "./useBrowserPreview";

vi.mock("../../data/previewActions", () => ({ fetchBrowserPreview: vi.fn() }));

const fetchPreviewMock = vi.mocked(fetchBrowserPreview);

describe("useBrowserPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchPreviewMock.mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:frame-1"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retains the last blob on 304 and revokes it when unmounted", async () => {
    fetchPreviewMock
      .mockResolvedValueOnce({
        kind: "frame",
        blob: new Blob(["png"], { type: "image/png" }),
        etag: '"one"',
        tabId: "tab-1",
        title: "Page",
        url: "https://example.test/",
        capturedAt: "1784060400000",
      })
      .mockResolvedValueOnce({ kind: "unchanged" });

    const { result, unmount } = renderHook(() => useBrowserPreview(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.state.frameUrl).toBe("blob:frame-1");
    expect(result.current.state.connection).toBe("connected");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.state.frameUrl).toBe("blob:frame-1");
    expect(fetchPreviewMock.mock.calls[1]?.[1]).toBe('"one"');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
  });

  it("does not poll while the page is hidden", async () => {
    fetchPreviewMock.mockResolvedValue({ kind: "unchanged" });
    renderHook(() => useBrowserPreview(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchPreviewMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchPreviewMock).toHaveBeenCalledTimes(1);
  });

  it("releases the current frame immediately when the document becomes hidden", async () => {
    fetchPreviewMock.mockResolvedValueOnce({
      kind: "frame",
      blob: new Blob(["png"], { type: "image/png" }),
      etag: '"one"',
      tabId: "tab-1",
      title: "Page",
      url: "https://example.test/",
      capturedAt: "1784060400000",
    });
    const { result } = renderHook(() => useBrowserPreview(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(result.current.state.frameUrl).toBe("");
    expect(result.current.state.activity).toBe("loading");
    expect(result.current.state.title).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
  });

  it("clears the previous scope frame and validator before loading another scope", async () => {
    fetchPreviewMock
      .mockResolvedValueOnce({
        kind: "frame",
        blob: new Blob(["png"], { type: "image/png" }),
        etag: '"one"',
        tabId: "tab-1",
        title: "Private",
        url: "https://example.test/",
        capturedAt: "1784060400000",
      })
      .mockResolvedValueOnce({ kind: "unchanged" });
    const initialScope: AgentPreviewScope = scope;
    const { result, rerender } = renderHook(
      ({ currentScope }) => useBrowserPreview(currentScope),
      { initialProps: { currentScope: initialScope } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    rerender({ currentScope: { scope_type: "channel", scope_id: "4" } });
    expect(result.current.state.frameUrl).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchPreviewMock.mock.calls[1]?.[1]).toBe("");
  });

  it("clears and revokes a stale frame when the browser becomes idle", async () => {
    fetchPreviewMock
      .mockResolvedValueOnce({
        kind: "frame",
        blob: new Blob(["png"], { type: "image/png" }),
        etag: '"one"',
        tabId: "tab-1",
        title: "Page",
        url: "https://example.test/",
        capturedAt: "1784060400000",
      })
      .mockResolvedValueOnce({ kind: "idle", etag: '"idle"', status: "idle" });

    const { result } = renderHook(() => useBrowserPreview(scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.state.frameUrl).toBe("blob:frame-1");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.state).toMatchObject({ activity: "idle", frameUrl: "", title: "", url: "" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
  });
});

const scope = { scope_type: "private", scope_id: "7" } as const;
