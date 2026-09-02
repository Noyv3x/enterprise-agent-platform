/* =====================================================================
   The single network primitive plus safeUrl and client-side JSON downloads.
   The 401 → session-expired hook is decoupled via registerSessionExpiredHandler
   so api.ts has no import cycle with the store; AppGate wires the real handler
   at boot.
   ===================================================================== */

import { t } from "../i18n";

type SessionExpiredHandler = () => void;
type PlatformUpdatingHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;
let platformUpdatingHandler: PlatformUpdatingHandler | null = null;
let sessionGeneration = 0;
const activeRequests = new Set<AbortController>();
const activeUploads = new Set<XMLHttpRequest>();

export const DEFAULT_API_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ApiRequestCancelledError extends Error {
  constructor() {
    super(t("api.cancelled"));
    this.name = "ApiRequestCancelledError";
  }
}

export class ApiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    const seconds = Math.ceil(timeoutMs / 1000);
    super(t("api.timeout", { count: seconds }));
    this.name = "ApiTimeoutError";
  }
}

export function isApiRequestCancelled(error: unknown): error is ApiRequestCancelledError {
  return error instanceof ApiRequestCancelledError;
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

/** AppGate registers the store's handleSessionExpired here at boot. */
export function registerSessionExpiredHandler(fn: SessionExpiredHandler): () => void {
  sessionExpiredHandler = fn;
  return () => {
    if (sessionExpiredHandler === fn) sessionExpiredHandler = null;
  };
}

/** UpdateGate registers this so an API maintenance response switches the
 * already-open application to its blocking screen without waiting for a poll. */
export function registerPlatformUpdatingHandler(fn: PlatformUpdatingHandler): () => void {
  platformUpdatingHandler = fn;
  return () => {
    if (platformUpdatingHandler === fn) platformUpdatingHandler = null;
  };
}

export function _invokePlatformUpdating(): void {
  platformUpdatingHandler?.();
}

/** Invoked by api() on a 401 (unless skipAuthHandling). */
export function _invokeSessionExpired(): void {
  sessionExpiredHandler?.();
}

/** Snapshot the account lifecycle generation before work that can defer request creation. */
export function getApiSessionGeneration(): number {
  return sessionGeneration;
}

/** Abort every request owned by the outgoing account and advance the response
 * generation. Even a fetch that wins the abort race is rejected before its
 * payload can be dispatched into the next account's store. */
export function resetApiSession(): void {
  sessionGeneration += 1;
  for (const controller of [...activeRequests]) controller.abort();
  activeRequests.clear();
  for (const upload of [...activeUploads]) upload.abort();
  activeUploads.clear();
}

export interface ApiOptions extends RequestInit {
  /** Opt out of the automatic 401 → handleSessionExpired drop-to-login. */
  skipAuthHandling?: boolean;
  /** Per-request timeout. Set to 0 only for an intentionally unbounded request. */
  timeoutMs?: number;
}

export interface ApiUploadProgress {
  loaded: number;
  total: number;
}

export interface ApiUploadOptions {
  /** Opt out of the automatic 401 → handleSessionExpired drop-to-login. */
  skipAuthHandling?: boolean;
  /** Upload cancellation remains supported even though wall-clock timeout is disabled. */
  signal?: AbortSignal;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  onProgress?: (progress: ApiUploadProgress) => void;
  /** Browser bytes are fully sent; the server may still be persisting the message. */
  onUploadComplete?: () => void;
}

function parsedJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function responseError(status: number, data: unknown, retryAfterHeader?: string | null): ApiError {
  const err = data as { code?: string; error?: string; detail?: string };
  const code = err.code || (err.error === "platform_updating" ? err.error : undefined);
  const parsedRetryAfter = /^\d+$/.test(retryAfterHeader || "")
    ? Math.min(86_400, Math.max(1, Number(retryAfterHeader)))
    : undefined;
  if (status === 503 && code === "platform_updating") {
    _invokePlatformUpdating();
  }
  return new ApiError(
    err.error || err.detail || t("api.failed", { status }),
    status,
    code,
    parsedRetryAfter,
  );
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const generation = sessionGeneration;
  const controller = new AbortController();
  const {
    skipAuthHandling = false,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    signal: callerSignal,
    ...requestOptions
  } = options;
  const isForm = requestOptions.body instanceof FormData;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const abortFromCaller = () => controller.abort();

  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  activeRequests.add(controller);

  try {
    const res = await fetch(path, {
      credentials: "include",
      // For FormData, leave Content-Type unset so the browser supplies the
      // multipart boundary. Explicit caller headers still take precedence.
      headers: isForm
        ? ((requestOptions.headers as HeadersInit | undefined) || {})
        : {
            "Content-Type": "application/json",
            ...((requestOptions.headers as Record<string, string> | undefined) || {}),
          },
      ...requestOptions,
      signal: controller.signal,
    });
    const text = await res.text();
    // A proxy can emit an HTML 502/504 page; preserve a useful status error.
    const data = parsedJson(text);
    if (generation !== sessionGeneration) throw new ApiRequestCancelledError();
    if (res.status === 401 && !skipAuthHandling) {
      _invokeSessionExpired();
      if (generation !== sessionGeneration) throw new ApiRequestCancelledError();
    }
    if (!res.ok) {
      throw responseError(res.status, data, res.headers?.get("Retry-After"));
    }
    return data as T;
  } catch (error) {
    if (timedOut) throw new ApiTimeoutError(timeoutMs);
    if (controller.signal.aborted || generation !== sessionGeneration) {
      throw new ApiRequestCancelledError();
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
    activeRequests.delete(controller);
  }
}

/** Multipart transport with browser upload progress and no fixed wall-clock timeout.
 * Session generation, explicit cancellation, 401, and maintenance handling match
 * api(). XMLHttpRequest is intentionally isolated to this boundary because Fetch
 * does not expose reliable upload progress. */
export function apiUpload<T = unknown>(
  path: string,
  body: FormData,
  options: ApiUploadOptions = {},
): Promise<T> {
  const generation = sessionGeneration;
  const {
    skipAuthHandling = false,
    signal: callerSignal,
    method = "POST",
    headers = {},
    onProgress,
    onUploadComplete,
  } = options;

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => {
      callerSignal?.removeEventListener("abort", abortFromCaller);
      activeUploads.delete(xhr);
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const cancel = () => finish(() => reject(new ApiRequestCancelledError()));
    const abortFromCaller = () => xhr.abort();

    xhr.open(method, path, true);
    xhr.withCredentials = true;
    // 0 is the XMLHttpRequest contract for no fixed timeout.
    xhr.timeout = 0;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (settled || generation !== sessionGeneration || !event.lengthComputable) return;
      onProgress?.({
        loaded: Math.max(0, event.loaded),
        total: Math.max(0, event.total),
      });
    };
    xhr.upload.onload = () => {
      if (!settled && generation === sessionGeneration) onUploadComplete?.();
    };
    xhr.onload = () => {
      if (generation !== sessionGeneration) {
        cancel();
        return;
      }
      const data = parsedJson(xhr.responseText || "");
      if (xhr.status === 401 && !skipAuthHandling) {
        _invokeSessionExpired();
        if (generation !== sessionGeneration) {
          cancel();
          return;
        }
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(() => reject(responseError(
          xhr.status,
          data,
          xhr.getResponseHeader("Retry-After"),
        )));
        return;
      }
      finish(() => resolve(data as T));
    };
    xhr.onerror = () => finish(() => reject(responseError(xhr.status || 0, {})));
    xhr.ontimeout = () => finish(() => reject(new ApiTimeoutError(xhr.timeout)));
    xhr.onabort = cancel;

    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    activeUploads.add(xhr);
    try {
      if (callerSignal?.aborted) xhr.abort();
      else xhr.send(body);
    } catch (error) {
      // XMLHttpRequest.send() may throw synchronously (for example when the
      // browser rejects the body or request state). Route that exit through the
      // same owner as async completion so the session registry and caller's
      // AbortSignal listener cannot leak.
      finish(() => reject(error));
    }
  });
}

/* ---------------------------------------------------------------- safeUrl */

interface SafeUrlOptions {
  allowData?: boolean;
}

// Only http(s)/relative URLs (plus mailto/tel) are allowed as link targets so a
// compromised or unexpected backend value such as "javascript:..." cannot run
// when an anchor is clicked. src attributes additionally allow data:/blob: for
// inline image previews. JSX does NOT block javascript: hrefs, so every
// backend-supplied href/src must run through this.
export function safeUrl(value: unknown, { allowData = false }: SafeUrlOptions = {}): string {
  // Strip control chars (incl. tab/newline/CR) first, so something like
  // "java\tscript:alert(1)" cannot smuggle a blocked scheme past the allow-list.
  const raw = String(value == null ? "" : value)
    .replace(new RegExp("[\\u0000-\\u001f\\u007f]", "g"), "")
    .trim();
  if (!raw) return "";
  if (/^(\/|\.|#|\?)/.test(raw)) return raw;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!match) return raw;
  const scheme = match[1].toLowerCase();
  const allowed = allowData
    ? ["http", "https", "blob", "data"]
    : ["http", "https", "mailto", "tel", "blob"];
  return allowed.includes(scheme) ? raw : "";
}

/* ------------------------------------------------------------ downloadJson */

/** Serialize `payload` to a pretty JSON blob and trigger a client download.
 *  Mirrors the OAuth credential-export anchor-blob-revoke pattern. */
export function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
