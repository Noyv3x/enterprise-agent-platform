import { posix } from "node:path";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { redactSensitiveText } from "./sensitive-text.js";

/** Keep draft bodies comfortably below the Runtime journal's per-run byte budget. */
export const FILE_DRAFT_MAX_BYTES = 16 * 1024;

/**
 * A partial credential may not match a complete-token pattern yet. Holding this
 * suffix keeps the fragment private until the next cumulative parse can redact
 * it. Unterminated PEM blocks receive an additional whole-block guard below.
 */
export const FILE_DRAFT_SAFETY_TAIL_BYTES = 512;

const FILE_DRAFT_INTERVAL_MS = 100;

type DraftToolCallUpdate = Extract<
  AssistantMessageEvent,
  { type: "toolcall_delta" | "toolcall_end" }
>;

export type FileDraftKind = "file" | "replacement";

export interface RuntimeFileDraft {
  workspace_path: string;
  kind: FileDraftKind;
  content: string;
  done: boolean;
  truncated: boolean;
}

export interface RuntimeFileDraftProjection {
  tool_call_id: string;
  tool_name: "write_file" | "patch_file";
  file_draft: RuntimeFileDraft;
}

interface DraftState {
  projection: RuntimeFileDraftProjection;
  publishedAt: number;
}

/** Project only Pi's parsed cumulative arguments, never raw JSON fragments. */
export class FileDraftProjector {
  private readonly states = new Map<string, DraftState>();

  constructor(private readonly now: () => number = Date.now) {}

  project(update: DraftToolCallUpdate): RuntimeFileDraftProjection | undefined {
    const argumentsFinished = update.type === "toolcall_end";
    const block = argumentsFinished ? update.toolCall : update.partial.content[update.contentIndex];
    if (!isToolCall(block) || (block.name !== "write_file" && block.name !== "patch_file")) return;
    const previous = this.states.get(block.id);
    const now = this.now();
    if (!argumentsFinished && previous && now - previous.publishedAt < FILE_DRAFT_INTERVAL_MS) return;
    const args = objectRecord(block.arguments);
    if (!sandboxTarget(args, argumentsFinished)) return;
    const path = canonicalWorkspacePath(args.path);
    if (path === undefined) return;
    const raw = args[block.name === "write_file" ? "content" : "new_text"];
    if (typeof raw !== "string") return;
    const safe = safeDraftContent(raw, argumentsFinished);
    if (!argumentsFinished && safe.content.length === 0) return;
    const projection: RuntimeFileDraftProjection = {
      tool_call_id: block.id,
      tool_name: block.name,
      file_draft: {
        workspace_path: path,
        kind: block.name === "write_file" ? "file" : "replacement",
        content: safe.content,
        done: false,
        truncated: safe.truncated,
      },
    };
    this.states.set(block.id, { projection, publishedAt: now });
    return projection;
  }

  finish(toolCallId: string): RuntimeFileDraftProjection | undefined {
    const state = this.states.get(toolCallId);
    if (!state) return;
    this.states.delete(toolCallId);
    return {
      ...state.projection,
      file_draft: { ...state.projection.file_draft, done: true },
    };
  }
}

function isToolCall(value: unknown): value is ToolCall {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "toolCall"
    && typeof (value as { id?: unknown }).id === "string"
    && (value as { id: string }).id.length > 0
    && (value as { id: string }).id === (value as { id: string }).id.trim()
    && (value as { id: string }).id.length <= 512
    && !/[\0-\x1f\x7f]/u.test((value as { id: string }).id)
    && typeof (value as { name?: unknown }).name === "string",
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isObjectRecord(value)
    ? value as Record<string, unknown>
    : {};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sandboxTarget(arguments_: Record<string, unknown>, complete: boolean): boolean {
  // Partial arguments may still append target=host; only complete calls get
  // the executable schema's implicit sandbox default.
  return arguments_.target === "sandbox"
    || (complete && (!Object.hasOwn(arguments_, "target") || arguments_.target === undefined));
}

function canonicalWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 4_096 || /[\\\0-\x1f\x7f]/u.test(value)) return;
  if (value.startsWith("/") && !value.startsWith("/workspace/")) return;
  const normalized = posix.normalize(value.startsWith("/workspace/") ? value.slice("/workspace/".length) : value);
  if (normalized === "" || normalized === "." || normalized === ".."
    || normalized.startsWith("../") || posix.isAbsolute(normalized)) return;
  return normalized;
}

function safeDraftContent(rawContent: string, complete: boolean): { content: string; truncated: boolean } {
  const redacted = redactDraftCredentials(rawContent);
  const redactedBytes = Buffer.byteLength(redacted);
  const visibleBytes = complete
    ? redactedBytes
    : Math.max(0, redactedBytes - FILE_DRAFT_SAFETY_TAIL_BYTES);
  const boundedBytes = Math.min(visibleBytes, FILE_DRAFT_MAX_BYTES);
  const content = utf8Prefix(redacted, boundedBytes);
  return {
    content,
    truncated: redactedBytes > FILE_DRAFT_MAX_BYTES,
  };
}

function redactDraftCredentials(value: string): string {
  return redactOpaqueCredentialRuns(
    redactSensitiveText(redactUrlUserinfo(redactUnterminatedPrivateKey(value))),
  );
}

/**
 * The shared sanitizer handles connection strings and token-only URL userinfo,
 * but not the common `scheme://user:password@host` shape. Redact that password
 * before a draft reaches the journal. Also suppress a non-port `user:secret`
 * authority at the end of a cumulative partial: without the closing `@`, a
 * sufficiently long password could otherwise extend beyond the safety tail.
 */
function redactUrlUserinfo(value: string): string {
  const redacted = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@?#]+):([^/\s@?#]+)(@)/gi,
    "$1$2:[redacted]$4",
  );
  return redacted.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)$/i,
    (candidate, scheme: string, authority: string) => {
      if (authority.includes("@") || authority.startsWith("[")) return candidate;
      const separator = authority.indexOf(":");
      if (separator <= 0) return candidate;
      const possiblePassword = authority.slice(separator + 1);
      if (possiblePassword.length === 0 || isNetworkPort(possiblePassword)) return candidate;
      return `${scheme}${authority.slice(0, separator)}:[redacted]`;
    },
  );
}

function isNetworkPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  return Number(value) <= 65_535;
}

function redactUnterminatedPrivateKey(value: string): string {
  const beginPattern = /-----BEGIN[A-Z ]*PRIVATE KEY-----/g;
  let match: RegExpExecArray | null;
  while ((match = beginPattern.exec(value)) !== null) {
    const suffix = value.slice(beginPattern.lastIndex);
    const end = /-----END[A-Z ]*PRIVATE KEY-----/.exec(suffix);
    if (!end) return `${value.slice(0, match.index)}[redacted-private-key]`;
    beginPattern.lastIndex += end.index + end[0].length;
  }
  return value;
}

function redactOpaqueCredentialRuns(value: string): string {
  return value.replace(/[A-Za-z0-9_+/=-]{48,}/g, (candidate) => {
    if (/^[A-Fa-f0-9]{48,}$/.test(candidate)) return "[redacted-long-hex]";
    const characterClasses = [
      /[a-z]/.test(candidate),
      /[A-Z]/.test(candidate),
      /[0-9]/.test(candidate),
      /[_+/=-]/.test(candidate),
    ].filter(Boolean).length;
    const uniqueCharacters = new Set(candidate).size;
    return characterClasses >= 3 && uniqueCharacters >= 10
      ? "[redacted-opaque-token]"
      : candidate;
  });
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // A UTF-8 scalar is at most four bytes; try the preceding boundary.
    }
  }
  return "";
}
