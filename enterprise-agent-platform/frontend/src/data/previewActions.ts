import { _invokePlatformUpdating, _invokeSessionExpired, api, ApiError } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { t } from "../i18n";
import type {
  AgentPreviewFileResponse,
  AgentPreviewScope,
  AgentPreviewStatusResponse,
  TerminalPreviewProcess,
} from "../types";

const MAX_BROWSER_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_STATUS_BYTES = 64 * 1024;
const MAX_FILE_PREVIEW_BYTES = 96 * 1024;

export interface PreviewAvailabilitySnapshot {
  kind: "snapshot";
  etag: string;
  browserActive: boolean;
  runningTerminalCount: number;
  presentAvailable: boolean;
}

export interface PreviewAvailabilityUnchanged {
  kind: "unchanged";
}

export type PreviewAvailabilityResult =
  | PreviewAvailabilitySnapshot
  | PreviewAvailabilityUnchanged;

export interface BrowserPreviewFrame {
  kind: "frame";
  blob: Blob;
  etag: string;
  refreshIntervalMs?: number;
  tabId: string;
  title: string;
  url: string;
  capturedAt: string;
}

export interface BrowserPreviewIdle {
  kind: "idle";
  etag: string;
  refreshIntervalMs?: number;
  status: string;
}

export interface PreviewUnchanged {
  kind: "unchanged";
  refreshIntervalMs?: number;
}

export type BrowserPreviewResult = BrowserPreviewFrame | BrowserPreviewIdle | PreviewUnchanged;

export interface BrowserControlResponse {
  active?: boolean;
  released?: boolean;
  lease_id?: string;
  tab_id?: string;
  expires_in_ms?: number;
  ok?: boolean;
  duplicate?: boolean;
  sequence?: number;
}

export type BrowserControlInput =
  | { action: "click" | "double_click"; x: number; y: number }
  | {
      action: "drag";
      points: Array<{ x: number; y: number; at_ms: number }>;
    }
  | { action: "text"; text: string }
  | { action: "key"; key: string }
  | { action: "wheel"; delta_x: number; delta_y: number }
  | { action: "back" | "forward" | "refresh" };

export function acquireBrowserControl(
  scope: AgentPreviewScope,
  tabId: string,
): Promise<BrowserControlResponse> {
  return api("/api/agent-previews/browser/control", {
    method: "POST",
    body: JSON.stringify({
      command: "acquire",
      scope_type: scope.scope_type,
      scope_id: String(scope.scope_id),
      tab_id: tabId,
    }),
  });
}

export function releaseBrowserControl(
  scope: AgentPreviewScope,
  tabId: string,
  leaseId: string,
): Promise<BrowserControlResponse> {
  return api("/api/agent-previews/browser/control", {
    method: "POST",
    body: JSON.stringify({
      command: "release",
      scope_type: scope.scope_type,
      scope_id: String(scope.scope_id),
      tab_id: tabId,
      lease_id: leaseId,
    }),
  });
}

export function sendBrowserControlInput(
  scope: AgentPreviewScope,
  tabId: string,
  leaseId: string,
  sequence: number,
  input: BrowserControlInput,
): Promise<BrowserControlResponse> {
  return api("/api/agent-previews/browser/control", {
    method: "POST",
    body: JSON.stringify({
      command: "input",
      scope_type: scope.scope_type,
      scope_id: String(scope.scope_id),
      tab_id: tabId,
      lease_id: leaseId,
      sequence,
      ...input,
    }),
  });
}

export interface TerminalPreviewResult {
  kind: "snapshot" | "unchanged";
  etag?: string;
  revision?: string;
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

function browserRefreshInterval(response: Response, fallback?: unknown): number | undefined {
  const raw = header(response, "x-preview-refresh-ms") || fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 100 && value <= 10_000
    ? value
    : undefined;
}

async function previewError(response: Response): Promise<Error> {
  if (response.status === 401) _invokeSessionExpired();
  let message = "";
  let code = "";
  try {
    const body = (await response.clone().json()) as {
      code?: string;
      error?: string;
      detail?: string;
    };
    message = body.error || body.detail || "";
    code = body.code || (body.error === "platform_updating" ? body.error : "");
  } catch {
    // Binary/proxy responses do not necessarily have a JSON error body.
  }
  if (response.status === 503 && code === "platform_updating") {
    _invokePlatformUpdating();
  }
  return new ApiError(
    message || t("api.failed", { status: response.status }),
    response.status,
    code || undefined,
  );
}

function assertBoundedResponse(response: Response, maxBytes: number, message: string): void {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(message);
}

export async function fetchPreviewAvailability(
  scope: AgentPreviewScope,
  etag: string,
  signal: AbortSignal,
): Promise<PreviewAvailabilityResult> {
  const response = await fetch(
    endpoints.previewStatus.path(scope.scope_type, scope.scope_id),
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
  assertBoundedResponse(response, MAX_PREVIEW_STATUS_BYTES, t("preview.loadFailed"));

  const body = (await response.json()) as Partial<AgentPreviewStatusResponse>;
  if (
    typeof body.browser_active !== "boolean" ||
    typeof body.running_terminal_count !== "number" ||
    !Number.isInteger(body.running_terminal_count) ||
    body.running_terminal_count < 0
    || typeof body.present_available !== "boolean"
  ) {
    throw new Error(t("preview.loadFailed"));
  }
  return {
    kind: "snapshot",
    etag: response.headers.get("etag") || "",
    browserActive: body.browser_active,
    runningTerminalCount: body.running_terminal_count,
    presentAvailable: body.present_available,
  };
}

export async function fetchPreviewFile(
  scope: AgentPreviewScope,
  workspacePath: string,
  signal: AbortSignal,
): Promise<AgentPreviewFileResponse> {
  const response = await fetch(
    endpoints.previewFile.path(scope.scope_type, scope.scope_id, workspacePath),
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) throw await previewError(response);
  assertBoundedResponse(response, MAX_FILE_PREVIEW_BYTES, t("computer.file.failed"));
  const body = (await response.json()) as Partial<AgentPreviewFileResponse>;
  if (typeof body.workspace_path !== "string" || typeof body.content !== "string") {
    throw new Error(t("computer.file.failed"));
  }
  return {
    workspace_path: body.workspace_path,
    content: body.content,
    truncated: body.truncated === true,
    encoding: typeof body.encoding === "string" ? body.encoding : "utf-8",
  };
}

export function presentPreviewUrl(scope: AgentPreviewScope): string {
  return endpoints.previewPresent.path(scope.scope_type, scope.scope_id);
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
  if (response.status === 304) {
    const refreshIntervalMs = browserRefreshInterval(response);
    return {
      kind: "unchanged",
      ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
    };
  }
  if (!response.ok) throw await previewError(response);

  const responseEtag = response.headers.get("etag") || "";
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (response.status === 204 || contentType === "application/json") {
    let status = "idle";
    if (response.status !== 204) {
      try {
        const body = (await response.json()) as {
          refresh_interval_ms?: number;
          status?: string;
          state?: string;
        };
        status = body.status || body.state || status;
        const refreshIntervalMs = browserRefreshInterval(response, body.refresh_interval_ms);
        return {
          kind: "idle",
          etag: responseEtag,
          ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
          status,
        };
      } catch {
        // Treat a malformed empty-state response as idle; no executable data is consumed.
      }
    }
    const refreshIntervalMs = browserRefreshInterval(response);
    return {
      kind: "idle",
      etag: responseEtag,
      ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
      status,
    };
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new Error(t("preview.loadFailed"));
  }
  assertBoundedResponse(response, MAX_BROWSER_FRAME_BYTES, t("preview.frameTooLarge"));
  const blob = await response.blob();
  if (blob.size > MAX_BROWSER_FRAME_BYTES) throw new Error(t("preview.frameTooLarge"));

  const refreshIntervalMs = browserRefreshInterval(response);
  return {
    kind: "frame",
    blob,
    etag: responseEtag,
    ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
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
  const status = string("status");
  if (!status || !["running", "completed", "failed", "cancelled", "orphaned"].includes(status)) {
    return null;
  }
  const running = boolean("running");
  if (running === undefined || (status === "orphaned" && !running)) return null;
  return {
    id,
    title: string("title") || string("name") || `Terminal ${index + 1}`,
    command: string("command"),
    cwd: string("cwd"),
    output: string("output"),
    status: status as TerminalPreviewProcess["status"],
    running,
    updated_at: (string("updated_at") ?? number("updated_at")),
    started_at: (string("started_at") ?? number("started_at")),
    finished_at: (string("finished_at") ?? number("finished_at")),
    exit_code: raw.exit_code === null ? null : number("exit_code"),
    truncated: boolean("truncated"),
  };
}

function previewRevision(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^preview_[A-Za-z0-9._-]{1,96}:\d{1,20}$/.test(value)
    ? value
    : undefined;
}

export async function fetchTerminalPreviews(
  scope: AgentPreviewScope,
  etag: string,
  sinceRevision: string | undefined,
  signal: AbortSignal,
): Promise<TerminalPreviewResult> {
  const response = await fetch(
    endpoints.terminalPreviews.path(
      scope.scope_type,
      scope.scope_id,
      sinceRevision,
    ),
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
  const revision = previewRevision(body.revision);
  if (body.revision !== undefined && revision === undefined) {
    throw new Error(t("preview.loadFailed"));
  }
  if (body.unchanged !== undefined && body.unchanged !== true) {
    throw new Error(t("preview.loadFailed"));
  }
  const responseEtag = response.headers.get("etag") || "";
  if (body.unchanged === true) {
    if (values.length > 0) throw new Error(t("preview.loadFailed"));
    return {
      kind: "unchanged",
      etag: responseEtag,
      revision,
    };
  }
  if (revision === undefined) throw new Error(t("preview.loadFailed"));
  return {
    kind: "snapshot",
    etag: responseEtag,
    revision,
    processes: values.map(normalizeProcess).filter((item): item is TerminalPreviewProcess => item !== null),
    capturedAt:
      header(response, "x-preview-captured-at") ||
      (typeof body.captured_at === "string" || typeof body.captured_at === "number"
        ? String(body.captured_at)
        : new Date().toISOString()),
  };
}
