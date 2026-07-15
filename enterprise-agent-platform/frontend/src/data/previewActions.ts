import { _invokeSessionExpired, ApiError } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { t } from "../i18n";
import type { AgentPreviewScope, TerminalPreviewProcess } from "../types";

const MAX_BROWSER_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface BrowserPreviewFrame {
  kind: "frame";
  blob: Blob;
  etag: string;
  tabId: string;
  title: string;
  url: string;
  capturedAt: string;
}

export interface BrowserPreviewIdle {
  kind: "idle";
  etag: string;
  status: string;
}

export interface PreviewUnchanged {
  kind: "unchanged";
}

export type BrowserPreviewResult = BrowserPreviewFrame | BrowserPreviewIdle | PreviewUnchanged;

export interface TerminalPreviewResult {
  kind: "snapshot" | "unchanged";
  etag?: string;
  processes?: TerminalPreviewProcess[];
  capturedAt?: string;
}

function header(response: Response, ...names: string[]): string {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value) return value;
  }
  return "";
}

function decodedHeader(response: Response, ...names: string[]): string {
  const value = header(response, ...names);
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function previewError(response: Response): Promise<Error> {
  if (response.status === 401) _invokeSessionExpired();
  let message = "";
  try {
    const body = (await response.clone().json()) as { error?: string; detail?: string };
    message = body.error || body.detail || "";
  } catch {
    // Binary/proxy responses do not necessarily have a JSON error body.
  }
  return new ApiError(message || t("api.failed", { status: response.status }), response.status);
}

function assertBoundedResponse(response: Response, maxBytes: number, message: string): void {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(message);
}

export async function fetchBrowserPreview(
  scope: AgentPreviewScope,
  etag: string,
  signal: AbortSignal,
): Promise<BrowserPreviewResult> {
  const response = await fetch(
    endpoints.browserPreview.path(scope.scope_type, scope.scope_id),
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: etag ? { "If-None-Match": etag } : undefined,
      signal,
    },
  );
  if (response.status === 304) return { kind: "unchanged" };
  if (!response.ok) throw await previewError(response);

  const responseEtag = response.headers.get("etag") || "";
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (response.status === 204 || contentType === "application/json") {
    let status = "idle";
    if (response.status !== 204) {
      try {
        const body = (await response.json()) as { status?: string; state?: string };
        status = body.status || body.state || status;
      } catch {
        // Treat a malformed empty-state response as idle; no executable data is consumed.
      }
    }
    return { kind: "idle", etag: responseEtag, status };
  }
  if (contentType !== "image/png") throw new Error(t("preview.loadFailed"));
  assertBoundedResponse(response, MAX_BROWSER_FRAME_BYTES, t("preview.frameTooLarge"));
  const blob = await response.blob();
  if (blob.size > MAX_BROWSER_FRAME_BYTES) throw new Error(t("preview.frameTooLarge"));

  return {
    kind: "frame",
    blob,
    etag: responseEtag,
    tabId: decodedHeader(response, "x-preview-tab-id"),
    title: decodedHeader(response, "x-preview-title", "x-preview-tab-title"),
    url: decodedHeader(response, "x-preview-url", "x-preview-tab-url"),
    capturedAt: header(response, "x-preview-captured-at") || new Date().toISOString(),
  };
}

function normalizeProcess(value: unknown, index: number): TerminalPreviewProcess | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id ?? raw.process_id ?? raw.session_id ?? "").trim();
  if (!id) return null;
  const string = (key: string): string | undefined =>
    typeof raw[key] === "string" ? raw[key] as string : undefined;
  const number = (key: string): number | undefined =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
  const boolean = (key: string): boolean | undefined =>
    typeof raw[key] === "boolean" ? raw[key] as boolean : undefined;
  return {
    id,
    title: string("title") || string("name") || `Terminal ${index + 1}`,
    command: string("command"),
    cwd: string("cwd"),
    content: string("content"),
    output: string("output"),
    screen: string("screen"),
    stdout: string("stdout"),
    stderr: string("stderr"),
    status: string("status"),
    running: boolean("running"),
    rows: number("rows"),
    columns: number("columns"),
    updated_at: (string("updated_at") ?? number("updated_at")),
    started_at: (string("started_at") ?? number("started_at")),
    finished_at: (string("finished_at") ?? number("finished_at")),
    exit_code: raw.exit_code === null ? null : number("exit_code"),
    truncated: boolean("truncated"),
  };
}

export async function fetchTerminalPreviews(
  scope: AgentPreviewScope,
  etag: string,
  signal: AbortSignal,
): Promise<TerminalPreviewResult> {
  const response = await fetch(
    endpoints.terminalPreviews.path(scope.scope_type, scope.scope_id),
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: etag ? { "If-None-Match": etag } : undefined,
      signal,
    },
  );
  if (response.status === 304) return { kind: "unchanged" };
  if (!response.ok) throw await previewError(response);
  assertBoundedResponse(response, MAX_TERMINAL_SNAPSHOT_BYTES, t("preview.loadFailed"));
  const text = await response.text();
  if (new Blob([text]).size > MAX_TERMINAL_SNAPSHOT_BYTES) throw new Error(t("preview.loadFailed"));
  const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  const values = Array.isArray(body.processes) ? body.processes : [];
  return {
    kind: "snapshot",
    etag: response.headers.get("etag") || (typeof body.revision === "string" ? body.revision : ""),
    processes: values.map(normalizeProcess).filter((item): item is TerminalPreviewProcess => item !== null),
    capturedAt:
      header(response, "x-preview-captured-at") ||
      (typeof body.captured_at === "string" || typeof body.captured_at === "number"
        ? String(body.captured_at)
        : new Date().toISOString()),
  };
}
