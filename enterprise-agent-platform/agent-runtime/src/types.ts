import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

export type JsonObject = Record<string, unknown>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
  schedule_id?: string;
  schedule_run_id?: string;
  scheduled_for?: string;
  available_skills?: unknown;
}

export type UserInput = string | Array<TextContent | ImageContent>;

export interface RunRequest {
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
  workspace: string;
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
  payload: JsonValue | AgentMessage;
}

export type ApprovalDecision = "once" | "session" | "always" | "deny";

export interface ApprovalRequest {
  id: string;
  run_id: string;
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
  tool_name: string;
  arguments: unknown;
  reason: string;
  created_at: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

export interface GatewayToolRequest {
  tool: "memory" | "session" | "knowledge" | "web" | "browser" | "schedule" | "skill";
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
