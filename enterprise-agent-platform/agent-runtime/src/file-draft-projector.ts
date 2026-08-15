import { posix } from "node:path";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { redactSensitiveText } from "./sensitive-text.js";

const CODEX_API = "openai-codex-responses";
const CODEX_PROVIDER = "openai-codex";

/** Keep draft bodies comfortably below the Runtime journal's per-run byte budget. */
export const FILE_DRAFT_MAX_BYTES = 16 * 1024;

/**
 * A partial credential may not match a complete-token pattern yet. Holding this
 * suffix keeps the fragment private until the next cumulative parse can redact
 * it. Unterminated PEM blocks receive an additional whole-block guard below.
 */
export const FILE_DRAFT_SAFETY_TAIL_BYTES = 512;

// Exponential early checkpoints make small files visibly stream. Past 1 KiB,
// fixed 2 KiB checkpoints avoid a long 8 -> 16 KiB UI pause while keeping the
// total journal body written by one tool call strictly bounded.
const FILE_DRAFT_CHECKPOINT_BYTES = Object.freeze([
  128,
  256,
  512,
  1_024,
  3_072,
  5_120,
  7_168,
  9_216,
  11_264,
  13_312,
  15_360,
]);

type DraftToolCallUpdate = Extract<
  AssistantMessageEvent,
  { type: "toolcall_delta" | "toolcall_end" }
>;

export type FileDraftKind = "file" | "replacement";

export interface RuntimeFileDraft {
  workspace_path: string;
  kind: FileDraftKind;
  content?: string;
  revision: number;
  complete: boolean;
  truncated: boolean;
  discarded: boolean;
}

export interface RuntimeFileDraftProjection {
  tool_call_id: string;
  tool_name: "write_file" | "patch_file";
  file_draft: RuntimeFileDraft;
}

interface DraftState {
  toolCallId: string;
  toolName: RuntimeFileDraftProjection["tool_name"];
  kind: FileDraftKind;
  workspacePath?: string;
  revision: number;
  nextCheckpoint: number;
  published: boolean;
  discarded: boolean;
  complete: boolean;
  truncated: boolean;
}

type Eligibility<T> =
  | { status: "allowed"; value: T }
  | { status: "pending" }
  | { status: "rejected" };

/**
 * Per-Run projector for the one provider/API pair whose adapter exposes
 * progressively parsed cumulative tool arguments. It never consumes or
 * returns the provider's raw JSON delta.
 */
export class CodexFileDraftProjector {
  private readonly states = new Map<string, DraftState>();
  private readonly activeByContentIndex = new Map<number, string>();

  constructor(private readonly enabled: boolean) {}

  /**
   * Normalize the complete compatibility default before Agent Core emits
   * message_end. This keeps the assistant call in the next model context and
   * durable session aligned with the Codex-only required-target schema.
   */
  normalizeCompleteTarget(update: Extract<AssistantMessageEvent, { type: "toolcall_end" }>): void {
    if (
      !this.enabled
      || update.partial.api !== CODEX_API
      || update.partial.provider !== CODEX_PROVIDER
      || !isToolCall(update.toolCall)
      || (update.toolCall.name !== "write_file" && update.toolCall.name !== "patch_file")
      || !isObjectRecord(update.toolCall.arguments)
      || Object.hasOwn(update.toolCall.arguments, "target")
    ) {
      return;
    }
    const normalizedArguments = { ...update.toolCall.arguments, target: "sandbox" };
    update.toolCall.arguments = normalizedArguments;
    const partialBlock = update.partial.content[update.contentIndex];
    if (
      isToolCall(partialBlock)
      && partialBlock.id === update.toolCall.id
      && partialBlock.name === update.toolCall.name
    ) {
      partialBlock.arguments = normalizedArguments;
    }
  }

  project(update: DraftToolCallUpdate): RuntimeFileDraftProjection | undefined {
    if (!this.enabled) return undefined;
    const complete = update.type === "toolcall_end";
    const activeId = this.activeByContentIndex.get(update.contentIndex);
    if (update.partial.api !== CODEX_API || update.partial.provider !== CODEX_PROVIDER) {
      return activeId ? this.discardAt(update.contentIndex, this.states.get(activeId), complete) : undefined;
    }

    const partialBlock = update.partial.content[update.contentIndex];
    const block = complete ? update.toolCall : partialBlock;
    if (!isToolCall(block)) {
      return activeId ? this.discardAt(update.contentIndex, this.states.get(activeId), complete) : undefined;
    }
    if (
      complete
      && isToolCall(partialBlock)
      && (partialBlock.id !== block.id || partialBlock.name !== block.name)
    ) {
      return activeId ? this.discardAt(update.contentIndex, this.states.get(activeId), true) : undefined;
    }
    if (activeId && activeId !== block.id) {
      return this.discardAt(update.contentIndex, this.states.get(activeId), complete);
    }
    if (block.name !== "write_file" && block.name !== "patch_file") {
      return activeId ? this.discardAt(update.contentIndex, this.states.get(activeId), complete) : undefined;
    }

    let state = this.states.get(block.id);
    if (!state) {
      state = {
        toolCallId: block.id,
        toolName: block.name,
        kind: block.name === "write_file" ? "file" : "replacement",
        revision: 0,
        nextCheckpoint: 0,
        published: false,
        discarded: false,
        complete: false,
        truncated: false,
      };
      this.states.set(block.id, state);
      this.activeByContentIndex.set(update.contentIndex, block.id);
    }
    if (state.complete) return undefined;
    if (state.toolName !== block.name) return this.discardAt(update.contentIndex, state, complete);
    if (state.discarded) return complete ? this.discardAt(update.contentIndex, state, true) : undefined;

    const arguments_ = objectRecord(block.arguments);
    const target = sandboxTarget(arguments_, complete);
    if (target.status === "rejected") return this.discardAt(update.contentIndex, state, complete);
    if (target.status === "pending") return undefined;

    const path = canonicalWorkspacePath(arguments_.path, complete);
    if (path.status === "rejected") return this.discardAt(update.contentIndex, state, complete);
    if (path.status === "pending") return undefined;
    if (state.published && state.workspacePath !== path.value) {
      // A normal cumulative JSON string cannot change after its closing quote.
      // Treat a post-publication path mutation as an unstable projection and
      // withdraw it instead of moving the same identity between files.
      return this.discardAt(update.contentIndex, state, complete);
    }
    state.workspacePath = path.value;

    const contentKey = state.toolName === "write_file" ? "content" : "new_text";
    const rawContent = arguments_[contentKey];
    if (typeof rawContent !== "string") {
      return complete || state.published
        ? this.discardAt(update.contentIndex, state, complete)
        : undefined;
    }

    const safe = safeDraftContent(rawContent, complete);
    state.truncated = safe.truncated;
    if (!complete) {
      const threshold = FILE_DRAFT_CHECKPOINT_BYTES[state.nextCheckpoint];
      if (threshold === undefined || safe.bytes < threshold) return undefined;
      while (
        state.nextCheckpoint < FILE_DRAFT_CHECKPOINT_BYTES.length
        && safe.bytes >= FILE_DRAFT_CHECKPOINT_BYTES[state.nextCheckpoint]!
      ) {
        state.nextCheckpoint += 1;
      }
    }

    state.revision += 1;
    state.published = true;
    state.complete = complete;
    if (complete) this.activeByContentIndex.delete(update.contentIndex);
    return {
      tool_call_id: state.toolCallId,
      tool_name: state.toolName,
      file_draft: {
        workspace_path: state.workspacePath,
        kind: state.kind,
        content: safe.content,
        revision: state.revision,
        complete,
        truncated: safe.truncated,
        discarded: false,
      },
    };
  }

  private discardAt(
    contentIndex: number,
    state: DraftState | undefined,
    complete: boolean,
  ): RuntimeFileDraftProjection | undefined {
    if (!state || state.complete) return undefined;
    if (!state.published || !state.workspacePath) {
      state.discarded = true;
      state.complete = complete;
      if (complete) this.activeByContentIndex.delete(contentIndex);
      return undefined;
    }
    // Emit the first withdrawal immediately. If toolcall_end follows, emit one
    // final complete withdrawal as the terminal revision for this identity.
    if (state.discarded && !complete) return undefined;
    state.revision += 1;
    state.discarded = true;
    state.complete = complete;
    if (complete) this.activeByContentIndex.delete(contentIndex);
    return {
      tool_call_id: state.toolCallId,
      tool_name: state.toolName,
      file_draft: {
        workspace_path: state.workspacePath,
        kind: state.kind,
        revision: state.revision,
        complete,
        truncated: state.truncated,
        discarded: true,
      },
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

function sandboxTarget(arguments_: Record<string, unknown>, complete: boolean): Eligibility<true> {
  if (!Object.hasOwn(arguments_, "target") || arguments_.target === undefined) {
    // The tool's complete-schema default is sandbox, but an unfinished JSON
    // object can still append target=host after content. Do not expose any
    // incomplete body until sandbox is explicit.
    return complete
      ? { status: "allowed", value: true }
      : { status: "pending" };
  }
  if (arguments_.target === "sandbox") return { status: "allowed", value: true };
  if (arguments_.target === "host") return { status: "rejected" };
  if (
    !complete
    && typeof arguments_.target === "string"
    && ("sandbox".startsWith(arguments_.target) || "host".startsWith(arguments_.target))
  ) {
    return { status: "pending" };
  }
  return { status: "rejected" };
}

function canonicalWorkspacePath(value: unknown, complete: boolean): Eligibility<string> {
  if (typeof value !== "string" || value.length === 0) {
    return complete ? { status: "rejected" } : { status: "pending" };
  }
  if (value.length > 4_096 || /[\\\0-\x1f\x7f]/u.test(value)) return { status: "rejected" };

  let relativePath = value;
  if (value.startsWith("/")) {
    if (value === "/workspace" || value === "/workspace/") {
      return complete ? { status: "rejected" } : { status: "pending" };
    }
    if (!value.startsWith("/workspace/")) {
      return !complete && "/workspace/".startsWith(value)
        ? { status: "pending" }
        : { status: "rejected" };
    }
    relativePath = value.slice("/workspace/".length);
  }

  const normalized = posix.normalize(relativePath);
  if (
    normalized === ""
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
  ) {
    return complete || normalized.startsWith("../")
      ? { status: "rejected" }
      : { status: "pending" };
  }
  return { status: "allowed", value: normalized };
}

function safeDraftContent(rawContent: string, complete: boolean): {
  content: string;
  bytes: number;
  truncated: boolean;
} {
  const redacted = redactDraftCredentials(rawContent);
  const redactedBytes = Buffer.byteLength(redacted);
  const visibleBytes = complete
    ? redactedBytes
    : Math.max(0, redactedBytes - FILE_DRAFT_SAFETY_TAIL_BYTES);
  const boundedBytes = Math.min(visibleBytes, FILE_DRAFT_MAX_BYTES);
  const content = utf8Prefix(redacted, boundedBytes);
  return {
    content,
    bytes: Buffer.byteLength(content),
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
