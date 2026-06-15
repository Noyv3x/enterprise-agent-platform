/* =====================================================================
   The single network primitive — ported byte-for-byte from legacy-app.js:73-94.
   Plus safeUrl (legacy 100-114) and downloadJson (the OAuth export blob pattern,
   legacy 3394-3403).

   The 401 → session-expired hook is decoupled via registerSessionExpiredHandler
   so api.ts has no import cycle with the store; AppGate wires the real handler
   at boot.
   ===================================================================== */

type SessionExpiredHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;

/** AppGate registers the store's handleSessionExpired here at boot. */
export function registerSessionExpiredHandler(fn: SessionExpiredHandler): void {
  sessionExpiredHandler = fn;
}

/** Invoked by api() on a 401 (unless skipAuthHandling). */
export function _invokeSessionExpired(): void {
  sessionExpiredHandler?.();
}

export interface ApiOptions extends RequestInit {
  /** Opt out of the automatic 401 → handleSessionExpired drop-to-login. */
  skipAuthHandling?: boolean;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const res = await fetch(path, {
    credentials: "include",
    // For FormData, pass headers through untouched so the browser sets the
    // multipart boundary. Otherwise default to JSON. `...options` is spread
    // last to preserve the exact legacy object-construction order.
    headers: isForm
      ? ((options.headers as HeadersInit | undefined) || {})
      : {
          "Content-Type": "application/json",
          ...((options.headers as Record<string, string> | undefined) || {}),
        },
    ...options,
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    // The server always returns JSON, but a fronting proxy can emit an HTML
    // 502/504 page (or an HTML login redirect); don't blow up on those.
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (res.status === 401 && !options.skipAuthHandling) {
    _invokeSessionExpired();
  }
  if (!res.ok) {
    const err = data as { error?: string; detail?: string };
    throw new Error(err.error || err.detail || `请求失败（${res.status}）`);
  }
  return data as T;
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
