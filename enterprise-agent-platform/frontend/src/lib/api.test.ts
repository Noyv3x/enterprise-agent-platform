import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentLocale } from "../i18n";
import {
  ApiError,
  ApiRequestCancelledError,
  ApiTimeoutError,
  api,
  apiUpload,
  registerPlatformUpdatingHandler,
  resetApiSession,
} from "./api";

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];
  readonly upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  method = "";
  path = "";
  timeout = -1;
  withCredentials = false;
  status = 0;
  responseText = "";
  body: FormData | null = null;
  abortCalls = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, path: string) {
    this.method = method;
    this.path = path;
  }

  setRequestHeader() {}

  getResponseHeader() { return null; }

  send(body: FormData) {
    this.body = body;
  }

  abort() {
    this.abortCalls += 1;
    this.onabort?.();
  }
}

class ThrowingSendXMLHttpRequest extends FakeXMLHttpRequest {
  send(_body: FormData) {
    throw new Error("send failed synchronously");
  }
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  setCurrentLocale("zh-CN");
  resetApiSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeXMLHttpRequest.instances = [];
});

describe("api request lifecycle", () => {
  it("uploads multipart data without a wall-clock timeout and reports byte progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const progress = vi.fn();
    const uploaded = vi.fn();
    const form = new FormData();
    form.append("content", "hello");

    const request = apiUpload<{ ok: boolean }>("/api/upload", form, {
      onProgress: progress,
      onUploadComplete: uploaded,
    });
    const xhr = FakeXMLHttpRequest.instances[0];
    expect(xhr.timeout).toBe(0);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.method).toBe("POST");
    expect(xhr.body).toBe(form);

    xhr.upload.onprogress?.({
      lengthComputable: true,
      loaded: 25,
      total: 100,
    } as unknown as ProgressEvent);
    xhr.upload.onload?.();
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ ok: true });
    xhr.onload?.();

    await expect(request).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith({ loaded: 25, total: 100 });
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  it("cancels an active multipart upload at the account generation boundary", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const request = apiUpload("/api/upload", new FormData());
    const xhr = FakeXMLHttpRequest.instances[0];

    resetApiSession();

    await expect(request).rejects.toBeInstanceOf(ApiRequestCancelledError);
    expect(xhr.body).toBeInstanceOf(FormData);
  });

  it("cleans upload ownership when XMLHttpRequest.send throws synchronously", async () => {
    vi.stubGlobal("XMLHttpRequest", ThrowingSendXMLHttpRequest);
    const controller = new AbortController();
    const request = apiUpload("/api/upload", new FormData(), {
      signal: controller.signal,
    });
    const xhr = FakeXMLHttpRequest.instances[0];

    await expect(request).rejects.toThrow("send failed synchronously");
    controller.abort();
    resetApiSession();

    expect(xhr.abortCalls).toBe(0);
  });

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
    await expect(request).rejects.toMatchObject({ status: 403, message: "forbidden" });
  });

  it("preserves a bounded Retry-After value on API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "slow down", code: "login_rate_limited" }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "42" } },
    )));

    await expect(api("/api/auth/login", { skipAuthHandling: true })).rejects.toMatchObject({
      status: 429,
      code: "login_rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("preserves the maintenance code and notifies the update gate", async () => {
    const handler = vi.fn();
    const unregister = registerPlatformUpdatingHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => response(503, {
      code: "platform_updating",
      error: "platform_updating",
    })));

    await expect(api("/api/test")).rejects.toMatchObject({
      status: 503,
      code: "platform_updating",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("localizes client-generated timeout and HTTP fallback errors", async () => {
    setCurrentLocale("en");
    expect(new ApiTimeoutError(1_000).message).toBe("Request timed out after 1 second");
    vi.stubGlobal("fetch", vi.fn(async () => response(503, {})));
    await expect(api("/api/unavailable")).rejects.toMatchObject({
      status: 503,
      message: "Request failed (503)",
    });
  });
});
