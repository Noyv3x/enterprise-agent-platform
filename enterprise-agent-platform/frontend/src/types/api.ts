/* =====================================================================
   Request / response payload types per endpoint. Shapes are verbatim from
   the legacy code + specs — paths/methods/bodies are a backend contract.
   ===================================================================== */

import type {
  AgentApprovalChoice,
  AgentStatus,
  AgentRuntimeConfigState,
  AutoUpdateConfigState,
  Channel,
  CogneeConfigState,
  FullDocument,
  KnowledgeDocument,
  KnowledgeHit,
  MentionTarget,
  Message,
  OAuthFlow,
  OAuthProvider,
  OAuthProvidersState,
  PermissionGroup,
  PrivateConversation,
  PrivateTelegram,
  RuntimeMap,
  Secret,
  SecurityConfigState,
  TelegramConfigState,
  TokenUsageReport,
  TypingUser,
  User,
} from "./models";

/* ------------------------------------------------------------------ auth */

export interface AuthMeResponse {
  user: User;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
}

export interface UpdateCurrentUserRequest {
  display_name: string;
  position: string;
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
  /** legacy sends the UNTRIMMED name verbatim. */
  name: string;
}

export interface ChannelMessagesResponse {
  messages: Message[];
  agent_status?: AgentStatus | null;
  typing?: TypingUser[];
}

export interface PrivateMessagesResponse {
  messages: Message[];
  agent_status?: AgentStatus | null;
}

/** JSON send body (the FormData variant carries `content` + repeated `files`). */
export interface PostMessageRequest {
  content: string;
}

export interface PostMessageResponse {
  user_message: Message;
  agent_status?: AgentStatus | null;
}

export interface AgentApprovalSubmitRequest {
  choice: AgentApprovalChoice;
  all?: boolean;
  resolve_all?: boolean;
}

export interface AgentApprovalSubmitResponse {
  ok?: boolean;
  approval?: unknown;
  agent_status?: AgentStatus | null;
}

export interface TypingRequest {
  typing: boolean;
}

/* -------------------------------------------------------- private agent */

export type PrivateTelegramResponse = PrivateTelegram;

/** Creating a Telegram link challenge accepts an intentionally empty object. */
export type PrivateTelegramUpdateRequest = Record<string, never>;

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
  host: string;
  /** raw input strings — backend parses; do not coerce to number. */
  port: string;
  session_ttl_seconds: string;
  session_secret: string;
}

export type AgentRuntimeConfigResponse = AgentRuntimeConfigState;

export interface AgentRuntimeConfigUpdateRequest {
  provider: string;
  model: string;
  timeout_seconds: string;
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

export interface AutoUpdateConfigUpdateRequest {
  enabled: boolean;
  interval_seconds: string;
  remote: string;
  branch: string;
  webhook_secret: string;
}

export type CogneeConfigResponse = CogneeConfigState;

export interface CogneeConfigUpdateRequest {
  env: Record<string, string>;
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
