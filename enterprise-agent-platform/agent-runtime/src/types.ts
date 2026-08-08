import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

export type JsonObject = Record<string, unknown>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Stable execution ownership assigned by the authenticated Platform request.
 * This object is deliberately not part of any model-visible tool schema.
 */
export interface ExecutionContext {
  sandbox_id: string;
  workspace_id: string;
}

export interface RuntimeConfig {
  home: string;
  host: string;
  port: number;
  bearerToken: string;
  platformUrl?: string;
  platformToken?: string;
  approvalTimeoutMs: number;
  runRetentionMs: number;
  maxDelegationDepth: number;
  maxDelegatesPerRun: number;
  maxBodyBytes: number;
  requestBodyTimeoutMs: number;
  compactionThreshold: number;
  runIdleTimeoutMs: number;
  maxTurnsPerRun: number;
  terminalTimeoutMs: number;
  cleanupGraceMs: number;
  maxConcurrency: number;
  maxQueuedRuns: number;
  executionMode: "manager" | "local";
  managerSocketPath?: string;
  managerToken?: string;
  managerRequestTimeoutMs: number;
}

export interface ModelRequest {
  provider: string;
  id: string;
  reasoning?: boolean;
}

export interface GatewayRequest {
  base_url?: string;
  token?: string;
}

export interface AttachmentRequest {
  path?: string;
  name?: string;
  mime_type?: string;
  url?: string;
}

export interface RunMetadata extends JsonObject {
  parent_run_id?: string;
  delegation_depth?: number;
  idempotency_key?: string;
  source_message_id?: number;
  approval_owner_run_id?: string;
  approval_scope_key?: string;
  approval_session_id?: string;
  trigger?: string;
  unattended?: boolean;
  review_mode?: string;
  review_job_id?: number;
  schedule_id?: string;
  schedule_run_id?: string;
  scheduled_for?: string;
  available_skills?: unknown;
}

export const LEARNING_REVIEW_MODE = "memory_skill";
export const LEARNING_REVIEW_TRIGGER = "learning_review";

/**
 * Return true only for the complete, Platform-issued learning-review context.
 * Individual metadata fields are not capability switches: callers must
 * provide the whole root private-run identity before Runtime narrows the tool
 * set or grants the review-specific mutation policy.
 */
export function isLearningReviewRun(request: Pick<RunRequest, "scope_key" | "session_id" | "metadata">): boolean {
  const metadata = request.metadata;
  if (!metadata || !/^private:[1-9][0-9]*$/.test(request.scope_key)) return false;
  const reviewJobId = metadata.review_job_id;
  return metadata.review_mode === LEARNING_REVIEW_MODE
    && metadata.trigger === LEARNING_REVIEW_TRIGGER
    && metadata.unattended === true
    && typeof reviewJobId === "number"
    && Number.isSafeInteger(reviewJobId)
    && reviewJobId > 0
    && request.session_id === `learning-review-${reviewJobId}`
    && metadata.idempotency_key === `agent-learning-review:${reviewJobId}`
    && typeof metadata.source_message_id === "number"
    && Number.isSafeInteger(metadata.source_message_id)
    && metadata.source_message_id > 0
    && (metadata.parent_run_id === undefined || metadata.parent_run_id === "")
    && (metadata.delegation_depth === undefined || metadata.delegation_depth === 0);
}

export function hasLearningReviewMetadata(
  request: Pick<RunRequest, "metadata">,
): boolean {
  const metadata = request.metadata;
  return Boolean(
    metadata
    && (
      metadata.review_mode !== undefined
      || metadata.review_job_id !== undefined
      || metadata.trigger === LEARNING_REVIEW_TRIGGER
    )
  );
}

export type UserInput = string | Array<TextContent | ImageContent>;

export interface RunRequest {
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
  workspace: string;
  execution_context?: ExecutionContext;
  system_prompt: string;
  input: UserInput;
  history?: AgentMessage[];
  attachments?: AttachmentRequest[];
  model: ModelRequest;
  thinking_level?: ThinkingLevel;
  gateway?: GatewayRequest;
  metadata?: RunMetadata;
}

export interface RunInputRequest {
  message_id: string;
  scope_key: string;
  lifecycle_id: string;
  input: UserInput;
  attachments?: AttachmentRequest[];
}

export type RunInputState = "accepted" | "injected" | "unconsumed";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_review";

export interface RuntimeEvent<T = JsonObject> {
  sequence: number;
  type: string;
  run_id: string;
  timestamp: string;
  data: T;
}

export interface RunResult {
  content: string;
  messages: AgentMessage[];
  model: { provider: string; id: string };
  usage?: JsonObject;
  context_usage?: ContextUsage;
  input_message_ids?: string[];
  unconsumed_input_message_ids?: string[];
}

/** Context occupied after the latest completed model turn. */
export interface ContextUsage {
  used_tokens: number;
  max_tokens: number;
  percent: number;
  estimated: boolean;
}

export interface RunRecord {
  id: string;
  request: RunRequest;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  controller: AbortController;
  result?: RunResult;
  error?: string;
  sideEffectsStarted: boolean;
  idleTimedOut?: boolean;
}

export interface SessionEntry {
  id: string;
  type: "header" | "message" | "compaction" | "run";
  timestamp: string;
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
  /** Runtime-owned marker; absent on unmarked/imported model content. */
  model_content_security_version?: number;
  /** Runtime-owned entry classification; never derived from message content. */
  synthetic_kind?: "context_compaction_notice";
  payload: JsonValue | AgentMessage;
}

export type ApprovalDecision = "once" | "session" | "always" | "deny";
export type ApprovalResolution = ApprovalDecision | "timeout" | "cancelled" | "notification_failed";
export type ApprovalOutcome = "approved" | "denied" | "timeout" | "cancelled" | "notification_failed";

export interface ApprovalResult {
  allowed: boolean;
  outcome: ApprovalOutcome;
}

export interface ApprovalRequest {
  id: string;
  run_id: string;
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
  tool_name: string;
  approval_key: string;
  /** Display-safe arguments only. Original execution arguments never enter the approval journal. */
  arguments: unknown;
  reason: string;
  allow_session: boolean;
  allow_permanent: boolean;
  created_at: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

export interface GatewayToolRequest {
  tool: "memory" | "session" | "knowledge" | "web" | "browser" | "schedule" | "skill" | "mail" | "sylver_platform";
  action: string;
  arguments: JsonObject;
  context: {
    run_id: string;
    scope_key: string;
    lifecycle_id: string;
    session_id: string;
    workspace: string;
    owner_user_id?: number;
    source_message_id?: number;
    tool_call_id?: string;
    parent_run_id?: string;
    delegation_depth?: number;
    trigger?: string;
    unattended?: boolean;
    review_mode?: string;
    review_job_id?: number;
  };
}

export interface GatewayToolResponse {
  content?: string;
  data?: JsonValue;
  memories?: JsonValue[];
  memory?: JsonValue;
  found?: boolean;
  is_error?: boolean;
  error?: string;
}
