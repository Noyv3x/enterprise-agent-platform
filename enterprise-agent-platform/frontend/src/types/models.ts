/* =====================================================================
   Domain models — faithfully reverse-engineered from legacy-app.js and the
   migration specs. These mirror the server payload shapes the legacy code
   consumed. Field names are part of the backend contract and must not drift.
   ===================================================================== */

/** Ids come back from the server as numbers but are compared with String()
 *  coercion throughout the legacy code, so callers may hold either. */
export type Id = string | number;

/** The 30 icon names registered in the legacy ICONS map (legacy-app.js:135). */
export type IconName =
  | "hash"
  | "bot"
  | "library"
  | "settings"
  | "send"
  | "search"
  | "sun"
  | "moon"
  | "logout"
  | "plus"
  | "checkCircle"
  | "alert"
  | "refresh"
  | "download"
  | "upload"
  | "paperclip"
  | "close"
  | "menu"
  | "external"
  | "loader"
  | "key"
  | "server"
  | "shield"
  | "doc"
  | "image"
  | "message"
  | "barChart"
  | "trash"
  | "link"
  | "users";

/** Top-level workspace view. */
export type ActiveView = "channel" | "private" | "knowledge" | "settings" | "admin";

/** Chat scope. Both names are used in the legacy code interchangeably. */
export type ScopeType = "channel" | "private";
export type ChatMode = ScopeType;

/** Message author. Open union — keep literal hints while allowing any string. */
export type AuthorType = "user" | "agent" | (string & {});

/** Agent run lifecycle state. Open union. */
export type AgentState =
  | "queued"
  | "replying"
  | "approval"
  | "error"
  | "complete"
  | "idle"
  | (string & {});

export type AgentApprovalChoice = "once" | "session" | "always" | "deny";

/* --------------------------------------------------------------- identity */

export interface User {
  id: Id;
  username: string;
  display_name?: string;
  role?: string;
  permission_group?: string;
  permission_group_label?: string;
  position?: string;
  permissions?: string[];
  model_name?: string;
  thinking_depth?: string;
  active?: boolean;
}

export interface PermissionGroup {
  id: string;
  label?: string;
  description?: string;
  permissions: string[];
}

export interface Channel {
  id: Id;
  name: string;
  description?: string;
  created_by?: Id | null;
  created_at?: number;
}

/* ------------------------------------------------------- chat / messages */

export interface Attachment {
  id: Id;
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  is_image?: boolean;
  url?: string;
  download_url?: string;
  /** true for optimistic blob: previews minted client-side via createObjectURL. */
  local_preview?: boolean;
}

/** A single line in an agent activity / work log (legacy-app.js:1014-1029). */
export interface ActivityStep {
  source?: string;
  stage?: string;
  label?: string;
  detail?: string;
  line?: string;
  tool?: string;
  tool_status?: string;
  emoji?: string;
  at?: number | string;
}

export interface AgentApprovalRequest {
  run_id?: string;
  command?: string;
  description?: string;
  pattern_key?: string;
  pattern_keys?: string[];
  choices?: AgentApprovalChoice[] | string[];
  requested_at?: number;
}

/** A streaming agent message fragment (legacy-app.js:948, 2910-2917). */
export interface StreamMsg {
  id?: Id;
  content?: string;
  updated_at?: number;
  username?: string;
  created_at?: number;
  /** false marks a finalized segment; undefined/true = live. */
  active?: boolean;
}

/** Who the agent is currently replying to (legacy-app.js:2918-2925). */
export interface AgentReplyTarget {
  id?: Id;
  username?: string;
  content?: string;
  created_at?: number;
}

/** The agent-work object embedded in a message's metadata (a completed run). */
export interface AgentWork {
  run_id?: string;
  state?: AgentState;
  current_step?: string;
  queued_count?: number;
  started_at?: number;
  scope_type?: ScopeType;
  scope_id?: Id;
  activity?: ActivityStep[];
  approval?: AgentApprovalRequest | null;
}

/** A live agent run status for a scope (superset of AgentWork). */
export interface AgentStatus extends AgentWork {
  replying_to?: AgentReplyTarget | null;
  stream_message?: StreamMsg | null;
  stream_messages?: StreamMsg[];
}

export interface AgentStatuses {
  channels: Record<string, AgentStatus>;
  private: AgentStatus | null;
}

/** Knowledge chips rendered inline under an agent message. */
export interface KnowledgeSuggestion {
  id: Id;
  title: string;
  summary?: string;
  source?: string;
  score?: number;
}

export interface MessageMetadata {
  local_pending?: boolean;
  streaming?: boolean;
  stream_segment?: boolean;
  knowledge_suggestions?: KnowledgeSuggestion[];
  agent_work?: AgentWork;
}

export interface Message {
  id: Id;
  /** present on optimistic + synthesized streaming messages. */
  scope_type?: ScopeType;
  scope_id?: string;
  author_type: AuthorType;
  user_id?: Id | null;
  username?: string;
  content?: string;
  attachments?: Attachment[];
  metadata?: MessageMetadata;
  created_at?: number;
}

/** @-mention autocomplete candidate (legacy-app.js:1041-1047). */
export interface MentionTarget {
  kind?: string;
  handle: string;
  label?: string;
  description?: string;
}

/** Other users typing in a channel (legacy-app.js:1175). */
export interface TypingUser {
  user_id?: Id;
  username?: string;
}

/* ------------------------------------------------------- private telegram */

export interface PrivateTelegramGateway {
  enabled?: boolean;
  bot_username?: string;
}

export interface PrivateTelegramLink {
  telegram_user_id?: string | number;
  telegram_username?: string;
}

export interface PrivateTelegramPending {
  status: "pending";
  expires_at: number;
  /** Returned only by the PUT that creates/rotates the one-time challenge. */
  code?: string;
  /** Telegram command containing the code, e.g. `/link ABCD-EFGH`. */
  command?: string;
}

export interface PrivateTelegram {
  gateway?: PrivateTelegramGateway;
  link?: PrivateTelegramLink | null;
  pending?: PrivateTelegramPending | null;
}

/* ------------------------------------------------------------- knowledge */

export interface KnowledgeDocument {
  id: number;
  title: string;
  summary: string;
  source: string;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

/** Alias kept for spec parity (the list shape). */
export type Document = KnowledgeDocument;

export interface FullDocument extends KnowledgeDocument {
  content: string;
}

export interface KnowledgeHit {
  id: number | string;
  title: string;
  summary: string;
  source: string;
  score: number;
}

export interface KnowledgeSearch {
  query: string;
  results: KnowledgeHit[] | null;
}

/* --------------------------------------------------------------- secrets */

export interface Secret {
  key: string;
  configured: boolean;
  masked: string;
}

/* --------------------------------------------------------------- runtime */

export interface RuntimeRow {
  name: string;
  available?: boolean;
  state?: string;
  detail?: string;
  error?: string;
  path?: string;
  managed?: boolean;
}

export type RuntimeMap = Record<string, RuntimeRow>;

/* ----------------------------------------------------------- token usage */

export interface TokenUsageWindow {
  days: number;
  since?: number | string;
  until?: number | string;
}

export interface TokenUsageSummary {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  event_count?: number;
  account_count?: number;
  channel_event_count?: number;
  private_event_count?: number;
}

export interface TokenDailyUsageRow {
  date?: string;
  label?: string;
  start_at?: number | string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  event_count?: number;
}

export interface TokenAccountRow {
  user_id?: Id;
  username?: string;
  display_name?: string;
  event_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  last_used_at?: number | string;
}

export interface TokenDetailRow {
  user_id?: Id;
  username?: string;
  display_name?: string;
  scope_type?: string;
  scope_name?: string;
  scope_id?: Id;
  provider?: string;
  model?: string;
  event_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface TokenScopeRow {
  scope_type?: string;
  scope_name?: string;
  scope_id?: Id;
  display_name?: string;
  username?: string;
  event_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface TokenModelRow {
  provider?: string;
  model?: string;
  event_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface TokenUsageReport {
  window?: TokenUsageWindow;
  summary?: TokenUsageSummary;
  today?: { total_tokens?: number };
  last_7_days?: { total_tokens?: number };
  daily_usage?: TokenDailyUsageRow[];
  by_account?: TokenAccountRow[];
  details?: TokenDetailRow[];
  by_scope?: TokenScopeRow[];
  by_model?: TokenModelRow[];
}

/* ----------------------------------------------------------------- oauth */

export interface OAuthAuthError {
  message?: string;
  detail?: string;
  code?: string;
  relogin_required?: boolean;
}

export interface OAuthProvider {
  id: string;
  label?: string;
  default_model?: string;
  configured?: boolean;
  active?: boolean;
  last_refresh?: number | string;
  last_auth_error?: OAuthAuthError | null;
  model_catalog_error?: string;
  models?: string[];
}

export interface OAuthProvidersState {
  providers: OAuthProvider[];
  active_provider?: string;
}

export type OAuthFlowKind = "device_code" | "manual_callback";

interface OAuthFlowBase {
  flow_id: string;
  status?: string;
  complete?: boolean;
}

export interface OAuthDeviceCodeFlow extends OAuthFlowBase {
  kind: "device_code";
  verification_url: string;
  user_code: string;
}

export interface OAuthManualCallbackFlow extends OAuthFlowBase {
  kind: "manual_callback";
  authorize_url: string;
  redirect_uri: string;
}

export type OAuthFlow = OAuthDeviceCodeFlow | OAuthManualCallbackFlow;

/* ------------------------------------------------------------ admin/config */

export type AdminPageId =
  | "accounts"
  | "tokens"
  | "messages"
  | "model"
  | "telegram"
  | "updates"
  | "security"
  | "runtime"
  | "hermes"
  | "cognee"
  | "secrets";

export interface AdminPage {
  id: AdminPageId;
  label: string;
  icon: IconName;
  description: string;
}

/** [value, label] tuple as in legacy THINKING_DEPTH_OPTIONS. */
export type ThinkingDepthOption = [value: string, label: string];

/** Descriptor-driven config field (Hermes/Cognee internal editors). */
export interface ConfigFieldDescriptor {
  key: string;
  label?: string;
  group?: string;
  kind?: "boolean" | "number" | "json" | "text";
  options?: string[];
  value?: unknown;
  configured?: boolean;
  defaulted?: boolean;
  secret?: boolean;
  masked?: string;
}

export interface ConfigSection {
  key: string;
  detail?: string;
}

/* security config */
export interface SecurityConfigValues {
  public_base_url?: string;
  trusted_proxy?: boolean;
  host?: string;
  port?: number | string;
  session_ttl_seconds?: number | string;
  session_secret_configured?: boolean;
  session_secret_source?: string;
  secure_cookie_enabled?: boolean;
  admin_default_password_active?: boolean;
  allow_default_admin_password?: boolean;
  listen_restart_required?: boolean;
  applied_host?: string;
  applied_port?: number | string;
  bootstrap_password_file_exists?: boolean;
}

export interface SecurityConfigState {
  config: SecurityConfigValues;
  restart_required?: boolean;
  session_secret_restart_required?: boolean;
}

/* hermes config */
export interface HermesModelCatalog {
  models?: string[];
  default_model?: string;
  error?: string;
}

export interface HermesConfigValues {
  manage_hermes?: boolean;
  repo_path?: string;
  api_url?: string;
  provider?: string;
  provider_base_url?: string;
  model?: string;
  install_extras?: string;
  startup_wait_seconds?: number | string;
  timeout_seconds?: number | string;
  api_key_configured?: boolean;
  model_catalog?: Record<string, HermesModelCatalog>;
}

export interface HermesConfigState {
  config: HermesConfigValues;
}

/* telegram admin config */
export interface TelegramConfigValues {
  enabled?: boolean;
  polling?: boolean;
  bot_username?: string;
  bot_token_configured?: boolean;
  webhook_secret_configured?: boolean;
  webhook_url?: string;
}

export interface TelegramLinkedUser {
  display_name?: string;
  username?: string;
  external_id?: string;
  telegram_username?: string;
  updated_at?: number | string;
}

export interface TelegramConfigState {
  config: TelegramConfigValues;
  linked_users?: TelegramLinkedUser[];
}

/* auto-update config */
export interface AutoUpdateConfigValues {
  enabled?: boolean;
  interval_seconds?: number | string;
  remote?: string;
  branch?: string;
  webhook_secret_configured?: boolean;
  webhook_url?: string;
}

export interface AutoUpdateStatus {
  in_progress?: boolean;
  update_started?: boolean;
  update_available?: boolean;
  dirty?: boolean;
  current_revision?: string;
  remote_revision?: string;
  last_check_at?: number | string;
  last_trigger?: string;
  last_error?: string;
  dirty_summary?: string;
}

export interface AutoUpdateConfigState {
  config: AutoUpdateConfigValues;
  status: AutoUpdateStatus;
}

/* hermes internal config */
export interface HermesInternalValues {
  fields?: ConfigFieldDescriptor[];
  env?: ConfigFieldDescriptor[];
  yaml_text?: string;
  config_path?: string;
  yaml_error?: string;
  default_error?: string;
  sections?: ConfigSection[];
}

export interface HermesInternalConfigState {
  internal: HermesInternalValues;
}

/* cognee internal config */
export interface CogneeInternalValues {
  env?: ConfigFieldDescriptor[];
  env_path?: string;
}

export interface CogneeConfigState {
  internal: CogneeInternalValues;
}

/* ----------------------------------------------------------- message audit */

export interface PrivateConversation {
  user_id: Id;
  display_name?: string;
  username?: string;
  last_message_at?: number | string;
  message_count?: number;
}

export interface MessageAudit {
  auditChannelId: string | null;
  channelMessages: Message[];
  channelTotal: number;
  privateConversations: PrivateConversation[];
  auditPrivateUserId: string | null;
  privateMessages: Message[];
  privateTotal: number;
}

/* ------------------------------------------------------- derived view data */

export interface TopbarInfo {
  title: string;
  icon?: IconName;
  hash?: boolean;
  sub: string;
}
