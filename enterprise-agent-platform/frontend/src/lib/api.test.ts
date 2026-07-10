import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiRequestCancelledError,
  ApiTimeoutError,
  api,
  resetApiSession,
} from "./api";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  resetApiSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api request lifecycle", () => {
  it("rejects a response from an outgoing session even when fetch ignores abort", async () => {
    let resolveFetch!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })),
    );

    const request = api<{ value: string }>("/api/test", { timeoutMs: 0 });
    resetApiSession();
    resolveFetch(response(200, { value: "old account" }));

    await expect(request).rejects.toBeInstanceOf(ApiRequestCancelledError);
  });

  it("turns the default fetch abort into an explicit timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      ),
    );

    const request = api("/api/slow", { timeoutMs: 1_000 });
    const assertion = expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("preserves HTTP status and server error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(403, { error: "forbidden" })));
    const request = api("/api/protected");
    await expect(request).rejects.toMatchObject<ApiError>({ status: 403, message: "forbidden" });
  });
});
