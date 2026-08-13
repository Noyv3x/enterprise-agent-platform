/* Request and response payload types for the platform API contract. */

import type {
  AgentApprovalChoice,
  AgentMemory,
  AgentMemoryTarget,
  AgentSkill,
  AgentStatus,
  AgentRuntimeConfigState,
  AgentSchedule,
  AgentScheduleRun,
  AutoUpdateConfigState,
  Channel,
  FullDocument,
  Id,
  KnowledgeConfigState,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexStatus,
  MentionTarget,
  MailAccount,
  MailSecurityMode,
  Message,
  OAuthFlow,
  OAuthProvider,
  OAuthProvidersState,
  PermissionGroup,
  PlatformUpdateStatus,
  PrivateConversation,
  PrivateTelegram,
  RuntimeMap,
  Secret,
  SecurityConfigState,
  SylverPlatformConnection,
  TelegramConfigState,
  TokenUsageReport,
  TypingUser,
  User,
} from "./models";

/* ------------------------------------------------------------- branding */

export interface BrandingSnapshot {
  schema_version: 1;
  revision: number;
  product_name: string;
  agent_name: string;
  primary_color: string;
  logo_url: string | null;
}

export interface BrandingConfigUpdateRequest {
  expected_revision: number;
  product_name: string;
  agent_name: string;
  primary_color: string;
}

export interface BrandingLogoUpdateRequest {
  expected_revision: number;
  mime_type: "image/png" | "image/webp";
  data_base64: string;
}

export interface BrandingLogoDeleteRequest {
  expected_revision: number;
}

/* ------------------------------------------------------------------ auth */

export interface AuthMeResponse {
  user: User;
}

export type MessageRevision = string | number;

export interface SessionBootstrapScope {
  scope_type: "channel" | "private";
  scope_id: string | number;
}

/** Authenticated shell data returned in one round trip. */
export interface SessionBootstrapResponse {
  user: User;
  channels: Channel[];
  mention_targets: MentionTarget[];
  active_scope: SessionBootstrapScope | null;
  messages: Message[];
  agent_status?: AgentStatus | null;
  typing?: TypingUser[];
  message_revision?: MessageRevision;
  reset_revision?: MessageRevision;
  next_after_id?: Id;
  next_before_id?: Id | null;
  has_more_before?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  bootstrap: SessionBootstrapResponse;
}

export interface UpdateCurrentUserRequest {
  display_name?: string;
  position?: string;
  timezone?: string;
}

export interface UpdateCurrentUserResponse {
  user: User;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface ChangePasswordResponse {
  user: User;
}

/* -------------------------------------------------------------- channels */

export interface ChannelsResponse {
  channels: Channel[];
}

export interface ChannelCreateRequest {
  /** The API receives the untrimmed name verbatim. */
  name: string;
}

export interface ChannelMessagesResponse {
  messages: Message[];
  agent_status?: AgentStatus | null;
  typing?: TypingUser[];
  message_revision?: MessageRevision;
  reset_revision?: MessageRevision;
  next_after_id?: Id;
  next_before_id?: Id | null;
  has_more_before?: boolean;
  mode?: "full" | "delta" | "history";
}

export interface PrivateMessagesResponse {
  messages: Message[];
  agent_status?: AgentStatus | null;
  message_revision?: MessageRevision;
  reset_revision?: MessageRevision;
  next_after_id?: Id;
  next_before_id?: Id | null;
  has_more_before?: boolean;
  mode?: "full" | "delta" | "history";
}

/** JSON send body (the FormData variant carries `content` + repeated `files`). */
export interface PostMessageRequest {
  content: string;
}

export interface PostMessageResponse {
  user_message: Message;
  agent_status?: AgentStatus | null;
  processing_mode?: "started" | "joined" | "queued" | string;
  input_group_id?: string;
}

export interface WithdrawChannelMessageResponse {
  withdrawn: true;
  message_id: Id;
}

export interface AgentApprovalSubmitRequest {
  choice: AgentApprovalChoice;
}

export interface AgentApprovalSubmitResponse {
  ok?: boolean;
  approval?: unknown;
  agent_status?: AgentStatus | null;
}

export interface AgentSessionCompactRequest {
  scope_type: "private" | "channel";
  scope_id: string;
}

export interface AgentSessionCompactResponse {
  compacted: boolean;
  omitted_messages: number;
  retained_messages: number;
}

export interface TypingRequest {
  typing: boolean;
}

/* -------------------------------------------------------- private agent */

export type PrivateTelegramResponse = PrivateTelegram;

/** Creating a Telegram link challenge accepts an intentionally empty object. */
export type PrivateTelegramUpdateRequest = Record<string, never>;

export interface MailAccountsResponse {
  accounts: MailAccount[];
  count: number;
}

export interface MailAccountResponse {
  account: MailAccount;
}

export interface MailAccountMutationRequest {
  label: string;
  email_address: string;
  username: string;
  imap_host: string;
  imap_port: number;
  imap_security: MailSecurityMode;
  smtp_host: string;
  smtp_port: number;
  smtp_security: MailSecurityMode;
  enabled: boolean;
  wake_enabled: boolean;
  wake_folder: string;
  poll_interval_seconds: number;
  password?: string;
}

export type MailAccountPatchRequest = Partial<MailAccountMutationRequest>;

export interface MailAccountTestResponse extends MailAccountResponse {
  ok: boolean;
  connections: { imap: boolean; smtp: boolean };
}

export interface MailAccountCheckResponse extends MailAccountResponse {
  ok: boolean;
  baseline: boolean;
  new_messages: number;
  stale: boolean;
}

export interface SylverPlatformConnectionResponse {
  connection: SylverPlatformConnection | null;
}

export interface SylverPlatformConnectionUpdateRequest {
  token: string;
}

export interface SylverPlatformIdentityPreview {
  base_url: string;
  remote_user_id: Id;
  username: string;
  full_name: string;
  title: string;
  email: string;
  role: string;
}

export interface SylverPlatformIdentityPreviewResponse {
  identity: SylverPlatformIdentityPreview;
}

export interface AdminSylverPlatformConnectionUpdateRequest {
  token: string;
  expected_remote_user_id: Id;
}

export interface AgentSchedulesResponse {
  schedules: AgentSchedule[];
}

export interface AgentScheduleResponse {
  schedule: AgentSchedule;
}

export interface AgentScheduleRunsResponse {
  runs: AgentScheduleRun[];
  next_before_id: number | null;
}

export interface AgentScheduleRunNowResponse extends AgentScheduleResponse {
  run: AgentScheduleRun;
}

export interface DeleteAgentScheduleResponse {
  deleted: true;
  id: number;
}

export interface AgentMemoriesResponse {
  memories: AgentMemory[];
  count: number;
  found: boolean;
}

export interface AgentMemoryMutationRequest {
  target: AgentMemoryTarget;
  content: string;
  tags?: string[];
}

export interface AgentMemoryMutationResponse {
  changed: AgentMemoryChange[];
}

export interface AgentMemoryChange {
  action: "add" | "replace" | "remove" | "clear" | (string & {});
  id?: number;
  created?: boolean;
  duplicate?: boolean;
  deleted?: number;
}

export type DeleteAgentMemoryResponse = AgentMemoryMutationResponse;

export interface AgentMemoriesExportResponse {
  version: number;
  exported_at: number | string;
  memories: AgentMemory[];
}

/* --------------------------------------------------------- Agent skills */

export interface AgentSkillsResponse {
  skills: AgentSkill[];
  count: number;
}

export interface AgentSkillResponse {
  skill: AgentSkill;
}

export interface AgentSkillCreateRequest {
  name: string;
  description: string;
  instructions: string;
  category: string;
  version: string;
  tags: string[];
  enabled: boolean;
}

export type AgentSkillPatchRequest = Partial<AgentSkillCreateRequest>;

export interface DeleteAgentSkillResponse {
  deleted: true;
  id: string;
}

/* --------------------------------------------------------------- mentions */

export interface MentionTargetsResponse {
  targets: MentionTarget[];
}

/* -------------------------------------------------------------- knowledge */

export interface DocumentsResponse {
  documents: KnowledgeDocument[];
}

export interface CreateDocumentRequest {
  title: string;
  source: string;
  summary: string;
  content: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeHit[];
}

export interface DocumentResponse {
  document: FullDocument;
}

export interface KnowledgeImportItem {
  document: KnowledgeDocument;
  created: boolean;
}

export interface KnowledgeImportResponse {
  documents: KnowledgeImportItem[];
}

/* ------------------------------------------------------------------ users */

export interface UsersResponse {
  users: User[];
}

export interface CreateUserRequest {
  username: string;
  display_name: string;
  password: string;
  position: string;
  permission_group: string;
  model_name: string;
  thinking_depth: string;
}

export interface UpdateUserRequest {
  display_name: string;
  position: string;
  permission_group: string;
  model_name: string;
  thinking_depth: string;
  active: boolean;
  /** "" means "keep existing password". */
  password: string;
}

export interface ImpersonateUserResponse {
  user: User;
}

export interface PermissionGroupsResponse {
  permission_groups: PermissionGroup[];
}

/* ------------------------------------------------------------ admin audit */

export interface AuditChannelMessagesResponse {
  messages?: Message[];
  total?: number;
}

export interface PrivateConversationsResponse {
  conversations?: PrivateConversation[];
}

export interface AuditPrivateMessagesResponse {
  messages?: Message[];
  total?: number;
}

/** DELETE body: remove everything before a unix-seconds timestamp. */
export interface DeleteBeforeRequest {
  before_created_at: number;
}

/** DELETE body: clear the whole scope. */
export interface DeleteClearAllRequest {
  clear_all: true;
}

export interface DeleteResultResponse {
  deleted?: number;
}

/* ------------------------------------------------------- token usage */

export type TokenUsageResponse = TokenUsageReport;

/* ---------------------------------------------------------------- secrets */

export interface SecretsResponse {
  secrets: Secret[];
}

export interface SetSecretRequest {
  value: string;
}

/* ------------------------------------------------------------ system/config */

export type RuntimeResponse = RuntimeMap;

export type SecurityConfigResponse = SecurityConfigState;

export interface SecurityConfigUpdateRequest {
  public_base_url: string;
  trusted_proxy: boolean;
  /** raw input strings — backend parses; do not coerce to number. */
  session_ttl_seconds: string;
  session_secret: string;
}

export type AgentRuntimeConfigResponse = AgentRuntimeConfigState;

export interface AgentRuntimeConfigUpdateRequest {
  provider: string;
  model: string;
  idle_timeout_seconds: string;
  max_concurrency: string;
  compaction_threshold: string;
}

export type TelegramConfigResponse = TelegramConfigState;

export interface TelegramConfigUpdateRequest {
  enabled: boolean;
  polling: boolean;
  bot_username: string;
  bot_token: string;
  webhook_secret: string;
}

export type AutoUpdateConfigResponse = AutoUpdateConfigState;

export type PlatformUpdateStatusResponse = PlatformUpdateStatus;

export interface AutoUpdateConfigUpdateRequest {
  enabled?: boolean;
  interval_seconds?: string;
  release_manifest_url?: string;
  lan_enabled?: boolean;
  lan_listen?: string;
  direct_access_cidrs?: string[];
  trusted_ingress_cidrs?: string[];
}

export interface ManagerOperationRequest {
  idempotency_key?: string;
  expected_generation?: number;
}

export type KnowledgeConfigResponse = KnowledgeConfigState;

export type KnowledgeStatusResponse = KnowledgeIndexStatus;

export interface KnowledgeConfigUpdateRequest {
  base_url: string;
  model: string;
  dimensions: number | null;
  batch_size: number;
  api_key: string;
}

/* ------------------------------------------------------------------ oauth */

export type OAuthProvidersResponse = OAuthProvidersState;

export interface OAuthFlowResponse {
  providers?: OAuthProvider[];
  active_provider?: string;
  flow?: OAuthFlow;
}

export interface OAuthPollRequest {
  flow_id: string;
}

export interface OAuthCompleteRequest {
  flow_id: string;
  callback_url: string;
}

export interface OAuthImportRequest {
  credentials: unknown;
}

export interface OAuthImportResponse extends OAuthFlowResponse {
  imported?: { keys?: string[] };
}

/* --------------------------------------------------------- live previews */

export interface AgentPreviewStatusResponse {
  browser_active: boolean;
  running_terminal_count: number;
}

export type TerminalProcessStatus = "running" | "completed" | "failed" | "cancelled" | "orphaned";

export interface TerminalPreviewProcess {
  id: string;
  title?: string;
  command?: string;
  cwd?: string;
  /** Bounded, plain-text combined terminal output returned by the platform. */
  output?: string;
  status: TerminalProcessStatus;
  running?: boolean;
  updated_at?: number | string;
  started_at?: number | string;
  finished_at?: number | string;
  exit_code?: number | null;
  truncated?: boolean;
}

export interface TerminalPreviewsResponse {
  processes: TerminalPreviewProcess[];
  captured_at?: number | string;
  revision: string;
  unchanged?: true;
}
