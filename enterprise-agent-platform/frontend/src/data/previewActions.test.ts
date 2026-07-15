import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBrowserPreview,
  fetchTerminalPreviews,
} from "./previewActions";

const scope = { scope_type: "private", scope_id: "7" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser preview transport", () => {
  it("requests an ETag and preserves an unchanged frame on 304", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBrowserPreview(scope, '"frame-1"', new AbortController().signal)).resolves.toEqual({
      kind: "unchanged",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-previews/browser?scope_type=private&scope_id=7",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        headers: { "If-None-Match": '"frame-1"' },
      }),
    );
  });

  it("accepts only bounded PNG frames and decodes safe metadata headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        ETag: '"frame-2"',
        "X-Preview-Tab-Id": "tab-1",
        "X-Preview-Title": "Docs%20page",
        "X-Preview-URL": "https%3A%2F%2Fexample.test%2Fdocs",
        "X-Preview-Captured-At": "1784060400000",
      },
    })));

    const result = await fetchBrowserPreview(scope, "", new AbortController().signal);
    expect(result).toMatchObject({
      kind: "frame",
      etag: '"frame-2"',
      tabId: "tab-1",
      title: "Docs page",
      url: "https://example.test/docs",
      capturedAt: "1784060400000",
    });
    expect(result.kind === "frame" && result.blob.size).toBe(4);
  });

  it("models a scope without an open tab as idle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      active: false,
      state: "idle",
      reason: "no_open_tab",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"idle-1"' },
    })));

    await expect(fetchBrowserPreview(scope, "", new AbortController().signal)).resolves.toEqual({
      kind: "idle",
      etag: '"idle-1"',
      status: "idle",
    });
  });
});

describe("terminal preview transport", () => {
  it("normalizes a bounded process snapshot and supports conditional refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      captured_at: 1784060400000,
      processes: [{
        id: "term-1",
        title: "Build",
        cwd: "/workspace",
        command: "npm test",
        screen: "ok\n",
        running: true,
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"term-2"' },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTerminalPreviews(scope, '"term-1"', new AbortController().signal);
    expect(result).toMatchObject({
      kind: "snapshot",
      etag: '"term-2"',
      capturedAt: "1784060400000",
      processes: [{ id: "term-1", title: "Build", screen: "ok\n", running: true }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-previews/terminals?scope_type=private&scope_id=7",
      expect.objectContaining({ headers: { "If-None-Match": '"term-1"' } }),
    );
  });

  it("returns unchanged for terminal 304 responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    await expect(fetchTerminalPreviews(scope, '"term-2"', new AbortController().signal)).resolves.toEqual({
      kind: "unchanged",
    });
  });
});
