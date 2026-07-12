/* =====================================================================
   The single network primitive — ported byte-for-byte from legacy-app.js:73-94.
   Plus safeUrl (legacy 100-114) and downloadJson (the OAuth export blob pattern,
   legacy 3394-3403).

   The 401 → session-expired hook is decoupled via registerSessionExpiredHandler
   so api.ts has no import cycle with the store; AppGate wires the real handler
   at boot.
   ===================================================================== */

import { t } from "../i18n";

type SessionExpiredHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;
let sessionGeneration = 0;
const activeRequests = new Set<AbortController>();

export const DEFAULT_API_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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

/** Invoked by api() on a 401 (unless skipAuthHandling). */
export function _invokeSessionExpired(): void {
  sessionExpiredHandler?.();
}

/** Abort every request owned by the outgoing account and advance the response
 * generation. Even a fetch that wins the abort race is rejected before its
 * payload can be dispatched into the next account's store. */
export function resetApiSession(): void {
  sessionGeneration += 1;
  for (const controller of [...activeRequests]) controller.abort();
  activeRequests.clear();
}

export interface ApiOptions extends RequestInit {
  /** Opt out of the automatic 401 → handleSessionExpired drop-to-login. */
  skipAuthHandling?: boolean;
  /** Per-request timeout. Set to 0 only for an intentionally unbounded request. */
  timeoutMs?: number;
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
    let data: unknown = {};
    if (text) {
      // A proxy can emit an HTML 502/504 page; preserve a useful status error.
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
    }
    if (generation !== sessionGeneration) throw new ApiRequestCancelledError();
    if (res.status === 401 && !skipAuthHandling) {
      _invokeSessionExpired();
      if (generation !== sessionGeneration) throw new ApiRequestCancelledError();
    }
    if (!res.ok) {
      const err = data as { error?: string; detail?: string };
      throw new ApiError(err.error || err.detail || t("api.failed", { status: res.status }), res.status);
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
