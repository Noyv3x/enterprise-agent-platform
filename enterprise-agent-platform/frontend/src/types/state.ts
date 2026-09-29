/* The canonical store shape and complete Action discriminated union used by
   every slice reducer. Render-only state such as focus and scroll requests stays
   in component refs rather than the shared store. */

import type {
  ActiveView,
  AdminPageId,
  AgentRuntimeConfigState,
  AgentStatus,
  AgentStatuses,
  AutoUpdateConfigState,
  Channel,
  ChatMode,
  Id,
  MentionTarget,
  Message,
  MessageAudit,
  OAuthFlow,
  OAuthProvider,
  OAuthProvidersState,
  PermissionGroup,
  PrivateTelegram,
  RuntimeMap,
  Secret,
  SecurityConfigState,
  TelegramConfigState,
  TokenUsageReport,
  TypingUser,
  User,
} from "./models";
import type { BrandingSnapshot } from "./api";

export interface AppState {
  /* auth slice */
  user: User | null;
  busy: boolean;
  pendingOperations: string[];
  error: string;

  /* chat slice */
  channels: Channel[];
  activeView: ActiveView;
  activeChannelId: Id | null;
  messages: Message[];
  privateMessages: Message[];
  pendingMessages: Message[];
  drafts: Record<string, string>;
  draftFiles: Record<string, File[]>;
  failedSends: Record<string, FailedSend[]>;
  messageSyncCursors: Record<string, MessageSyncCursor>;
  messageHistory: Record<string, MessageHistoryState>;
  agentStatuses: AgentStatuses;
  expandedAgentRuns: Record<string, boolean>;
  mentionTargets: MentionTarget[];
  typingUsers: TypingUser[];
  privateTelegram: PrivateTelegram | null;
  privateTelegramExpanded: boolean;

  /* admin slice */
  users: User[];
  permissionGroups: PermissionGroup[];
  activeAdminPage: AdminPageId;
  messageAudit: MessageAudit;
  tokenUsage: TokenUsageReport | null;
  tokenUsageDays: number;
  secrets: Secret[];
  runtimes: RuntimeMap | null;
  agentRuntimeConfig: AgentRuntimeConfigState | null;
  telegramConfig: TelegramConfigState | null;
  autoUpdateConfig: AutoUpdateConfigState | null;
  brandingConfig: BrandingSnapshot | null;
  securityConfig: SecurityConfigState | null;
  oauthProviders: OAuthProvidersState | null;
  oauthFlows: Record<string, OAuthFlow>;

  /* ui slice */
  sidebarOpen: boolean;
  personalAiGuideOpen: boolean;
  personalAiGuideShownThisSession: boolean;
  resourceStates: Record<string, ResourceState>;
}

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface ResourceState {
  status: ResourceStatus;
  error: string;
  updatedAt: number | null;
}

/** A failed payload retained intact until it can be restored into the composer. */
export interface FailedSend {
  id: string;
  content: string;
  files: File[];
}

/**
 * The last server-confirmed synchronization point for a conversation.
 *
 * Keep this separate from the visible message list: a successful optimistic
 * POST can add a newer durable message before an older SSE-announced message
 * has been pulled. Advancing from the rendered list would skip that gap.
 */
export interface MessageSyncCursor {
  afterId: string;
  revision: string | number;
  /** Last destructive hide/delete boundary observed from the server. */
  resetRevision?: string | number;
}

export interface MessageHistoryState {
  nextBeforeId: string | null;
  hasMore: boolean;
  loading: boolean;
  error: string;
  /** Changes atomically with a successful prepend so scroll anchoring can distinguish it from new messages. */
  prependVersion: number;
}

/* ----------------------------- per-slice state sub-types (for slice files) */

export type AuthSliceState = Pick<AppState, "user" | "busy" | "pendingOperations" | "error">;

export type ChatSliceState = Pick<
  AppState,
  | "channels"
  | "activeView"
  | "activeChannelId"
  | "messages"
  | "privateMessages"
  | "pendingMessages"
  | "drafts"
  | "draftFiles"
  | "failedSends"
  | "messageSyncCursors"
  | "messageHistory"
  | "agentStatuses"
  | "expandedAgentRuns"
  | "mentionTargets"
  | "typingUsers"
  | "privateTelegram"
  | "privateTelegramExpanded"
>;

export type AdminSliceState = Pick<
  AppState,
  | "users"
  | "permissionGroups"
  | "activeAdminPage"
  | "messageAudit"
  | "tokenUsage"
  | "tokenUsageDays"
  | "secrets"
  | "runtimes"
  | "agentRuntimeConfig"
  | "telegramConfig"
  | "autoUpdateConfig"
  | "brandingConfig"
  | "securityConfig"
  | "oauthProviders"
  | "oauthFlows"
>;

export type UiSliceState = Pick<
  AppState,
  "sidebarOpen" | "personalAiGuideOpen" | "personalAiGuideShownThisSession" | "resourceStates"
>;

/** Payloads keyed by action type; the mapped union keeps switch narrowing exact. */
interface ActionPayloads {
  /* cross-cutting and auth */
  BEGIN_BUSY: string;
  END_BUSY: string;
  SET_ERROR: string;
  SET_USER: User | null;

  /* chat */
  SET_CHANNELS: Channel[];
  REMOVE_CHANNEL_SCOPE: Id;
  SET_ACTIVE_VIEW: ActiveView;
  SET_ACTIVE_CHANNEL_ID: Id | null;
  SET_MESSAGES: Message[];
  SET_PRIVATE_MESSAGES: Message[];
  SET_MESSAGE_SYNC_CURSOR: { key: string; cursor: MessageSyncCursor };
  SET_MESSAGE_HISTORY: { key: string; history: MessageHistoryState };
  PREPEND_MESSAGES: {
    mode: ChatMode;
    scopeId: string;
    messages: Message[];
    nextBeforeId: string | null;
    hasMore: boolean;
  };
  ADD_PENDING_MESSAGE: { mode: ChatMode; scopeId: string; message: Message };
  REPLACE_OPTIMISTIC_MESSAGE: { mode: ChatMode; scopeId: string; tempId: Id; saved: Message | null };
  REMOVE_OPTIMISTIC_MESSAGE: { mode: ChatMode; scopeId: string; tempId: Id };
  UPDATE_OPTIMISTIC_UPLOAD: { tempId: Id; upload: NonNullable<Message["metadata"]>["upload"] };
  SET_AGENT_STATUS: {
    mode: ChatMode;
    scopeId: string;
    status: AgentStatus | null;
    /** A transport fence proved this response is current for the scope. */
    authoritative?: boolean;
  };
  SET_AGENT_STATUSES: AgentStatuses;
  TOGGLE_AGENT_RUN: { runId: string; expanded: boolean };
  SET_MENTION_TARGETS: MentionTarget[];
  SET_TYPING_USERS: TypingUser[];
  SET_DRAFT: { key: string; value: string };
  SET_DRAFT_FILES: { key: string; files: File[] };
  REMOVE_DRAFT_FILES: { key: string };
  ADD_FAILED_SEND: { key: string; send: FailedSend };
  RESTORE_NEXT_FAILED_SEND: { key: string };
  SET_PRIVATE_TELEGRAM: PrivateTelegram | null;
  SET_PRIVATE_TELEGRAM_EXPANDED: boolean;

  /* admin */
  SET_USERS: User[];
  SET_PERMISSION_GROUPS: PermissionGroup[];
  SET_ACTIVE_ADMIN_PAGE: AdminPageId;
  PATCH_MESSAGE_AUDIT: Partial<MessageAudit>;
  SET_TOKEN_USAGE: TokenUsageReport | null;
  SET_TOKEN_USAGE_DAYS: number;
  SET_SECRETS: Secret[];
  SET_RUNTIMES: RuntimeMap | null;
  SET_AGENT_RUNTIME_CONFIG: AgentRuntimeConfigState | null;
  SET_TELEGRAM_CONFIG: TelegramConfigState | null;
  SET_AUTO_UPDATE_CONFIG: AutoUpdateConfigState | null;
  SET_BRANDING_CONFIG: BrandingSnapshot | null;
  SET_SECURITY_CONFIG: SecurityConfigState | null;
  SET_OAUTH_PROVIDERS: OAuthProvidersState | null;
  /** Merge an OAuth provider state response for one provider. */
  SET_OAUTH_STATE: { providerId: string; providers: OAuthProvider[]; flow?: OAuthFlow | null };

  /* ui */
  SET_SIDEBAR_OPEN: boolean;
  SET_PERSONAL_AI_GUIDE_OPEN: { open: boolean; markShown?: boolean };
  SET_RESOURCE_STATE: { key: string; state: ResourceState };
}

export type Action =
  | { type: "RESET_SESSION" }
  | { type: "TOGGLE_SIDEBAR" }
  | { [T in keyof ActionPayloads]: { type: T; payload: ActionPayloads[T] } }[keyof ActionPayloads];

/** Discriminated-union helper: the action for a given `type`. */
export type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;
