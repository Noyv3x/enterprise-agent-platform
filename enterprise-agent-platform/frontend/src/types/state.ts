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
  FullDocument,
  Id,
  KnowledgeConfigState,
  KnowledgeDocument,
  KnowledgeIndexStatus,
  KnowledgeSearch,
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

  /* knowledge slice */
  documents: KnowledgeDocument[];
  knowledgeSearch: KnowledgeSearch;
  selectedDocument: FullDocument | null;

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
  knowledgeConfig: KnowledgeConfigState | null;
  knowledgeStatus: KnowledgeIndexStatus | null;
  securityConfig: SecurityConfigState | null;
  oauthProviders: OAuthProvidersState | null;
  oauthFlows: Record<string, OAuthFlow>;
  oauthCallbackUrls: Record<string, string>;

  /* ui slice */
  sidebarOpen: boolean;
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

export type KnowledgeSliceState = Pick<
  AppState,
  "documents" | "knowledgeSearch" | "selectedDocument"
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
  | "knowledgeConfig"
  | "knowledgeStatus"
  | "securityConfig"
  | "oauthProviders"
  | "oauthFlows"
  | "oauthCallbackUrls"
>;

export type UiSliceState = Pick<AppState, "sidebarOpen" | "resourceStates">;

/* ===================================================================== */
/* Action discriminated union — the contract every reducer is filled against. */
/* ===================================================================== */

/* cross-cutting */
interface ResetSessionAction {
  type: "RESET_SESSION";
}
interface BeginBusyAction {
  type: "BEGIN_BUSY";
  payload: string;
}
interface EndBusyAction {
  type: "END_BUSY";
  payload: string;
}
interface SetErrorAction {
  type: "SET_ERROR";
  payload: string;
}

/* auth slice */
interface SetUserAction {
  type: "SET_USER";
  payload: User | null;
}

/* chat slice */
interface SetChannelsAction {
  type: "SET_CHANNELS";
  payload: Channel[];
}
interface SetActiveViewAction {
  type: "SET_ACTIVE_VIEW";
  payload: ActiveView;
}
interface SetActiveChannelIdAction {
  type: "SET_ACTIVE_CHANNEL_ID";
  payload: Id | null;
}
interface SetMessagesAction {
  type: "SET_MESSAGES";
  payload: Message[];
}
interface SetPrivateMessagesAction {
  type: "SET_PRIVATE_MESSAGES";
  payload: Message[];
}
interface SetMessageSyncCursorAction {
  type: "SET_MESSAGE_SYNC_CURSOR";
  payload: { key: string; cursor: MessageSyncCursor };
}
interface SetMessageHistoryAction {
  type: "SET_MESSAGE_HISTORY";
  payload: { key: string; history: MessageHistoryState };
}
interface PrependMessagesAction {
  type: "PREPEND_MESSAGES";
  payload: {
    mode: ChatMode;
    scopeId: string;
    messages: Message[];
    nextBeforeId: string | null;
    hasMore: boolean;
  };
}
interface SetPendingMessagesAction {
  type: "SET_PENDING_MESSAGES";
  payload: Message[];
}
interface AddPendingMessageAction {
  type: "ADD_PENDING_MESSAGE";
  payload: { mode: ChatMode; scopeId: string; message: Message };
}
interface ReplaceOptimisticMessageAction {
  type: "REPLACE_OPTIMISTIC_MESSAGE";
  payload: { mode: ChatMode; scopeId: string; tempId: Id; saved: Message | null };
}
interface RemoveOptimisticMessageAction {
  type: "REMOVE_OPTIMISTIC_MESSAGE";
  payload: { mode: ChatMode; scopeId: string; tempId: Id };
}
interface UpdateOptimisticUploadAction {
  type: "UPDATE_OPTIMISTIC_UPLOAD";
  payload: { tempId: Id; upload: NonNullable<Message["metadata"]>["upload"] };
}
interface SetAgentStatusAction {
  type: "SET_AGENT_STATUS";
  payload: {
    mode: ChatMode;
    scopeId: string;
    status: AgentStatus | null;
    /** A transport fence proved this response is current for the scope. */
    authoritative?: boolean;
  };
}
interface SetAgentStatusesAction {
  type: "SET_AGENT_STATUSES";
  payload: AgentStatuses;
}
interface ToggleAgentRunAction {
  type: "TOGGLE_AGENT_RUN";
  payload: { runId: string; expanded: boolean };
}
interface SetExpandedAgentRunsAction {
  type: "SET_EXPANDED_AGENT_RUNS";
  payload: Record<string, boolean>;
}
interface SetMentionTargetsAction {
  type: "SET_MENTION_TARGETS";
  payload: MentionTarget[];
}
interface SetTypingUsersAction {
  type: "SET_TYPING_USERS";
  payload: TypingUser[];
}
interface SetDraftsAction {
  type: "SET_DRAFTS";
  payload: Record<string, string>;
}
interface SetDraftAction {
  type: "SET_DRAFT";
  payload: { key: string; value: string };
}
interface SetDraftFilesAction {
  type: "SET_DRAFT_FILES";
  payload: { key: string; files: File[] };
}
interface RemoveDraftFilesAction {
  type: "REMOVE_DRAFT_FILES";
  payload: { key: string };
}
interface AddFailedSendAction {
  type: "ADD_FAILED_SEND";
  payload: { key: string; send: FailedSend };
}
interface RestoreNextFailedSendAction {
  type: "RESTORE_NEXT_FAILED_SEND";
  payload: { key: string };
}
interface SetPrivateTelegramAction {
  type: "SET_PRIVATE_TELEGRAM";
  payload: PrivateTelegram | null;
}
interface SetPrivateTelegramExpandedAction {
  type: "SET_PRIVATE_TELEGRAM_EXPANDED";
  payload: boolean;
}

/* knowledge slice */
interface SetDocumentsAction {
  type: "SET_DOCUMENTS";
  payload: KnowledgeDocument[];
}
interface SetKnowledgeSearchAction {
  type: "SET_KNOWLEDGE_SEARCH";
  payload: KnowledgeSearch;
}
interface SetSelectedDocumentAction {
  type: "SET_SELECTED_DOCUMENT";
  payload: FullDocument | null;
}

/* admin slice */
interface SetUsersAction {
  type: "SET_USERS";
  payload: User[];
}
interface SetPermissionGroupsAction {
  type: "SET_PERMISSION_GROUPS";
  payload: PermissionGroup[];
}
interface SetActiveAdminPageAction {
  type: "SET_ACTIVE_ADMIN_PAGE";
  payload: AdminPageId;
}
interface SetMessageAuditAction {
  type: "SET_MESSAGE_AUDIT";
  payload: MessageAudit;
}
interface PatchMessageAuditAction {
  type: "PATCH_MESSAGE_AUDIT";
  payload: Partial<MessageAudit>;
}
interface SetTokenUsageAction {
  type: "SET_TOKEN_USAGE";
  payload: TokenUsageReport | null;
}
interface SetTokenUsageDaysAction {
  type: "SET_TOKEN_USAGE_DAYS";
  payload: number;
}
interface SetSecretsAction {
  type: "SET_SECRETS";
  payload: Secret[];
}
interface SetRuntimesAction {
  type: "SET_RUNTIMES";
  payload: RuntimeMap | null;
}
interface SetAgentRuntimeConfigAction {
  type: "SET_AGENT_RUNTIME_CONFIG";
  payload: AgentRuntimeConfigState | null;
}
interface SetTelegramConfigAction {
  type: "SET_TELEGRAM_CONFIG";
  payload: TelegramConfigState | null;
}
interface SetAutoUpdateConfigAction {
  type: "SET_AUTO_UPDATE_CONFIG";
  payload: AutoUpdateConfigState | null;
}
interface SetBrandingConfigAction {
  type: "SET_BRANDING_CONFIG";
  payload: BrandingSnapshot | null;
}
interface SetKnowledgeConfigAction {
  type: "SET_KNOWLEDGE_CONFIG";
  payload: KnowledgeConfigState | null;
}
interface SetKnowledgeStatusAction {
  type: "SET_KNOWLEDGE_STATUS";
  payload: KnowledgeIndexStatus | null;
}
interface SetSecurityConfigAction {
  type: "SET_SECURITY_CONFIG";
  payload: SecurityConfigState | null;
}
interface SetOAuthProvidersAction {
  type: "SET_OAUTH_PROVIDERS";
  payload: OAuthProvidersState | null;
}
/** Merge an OAuth provider state response for one provider. */
interface SetOAuthStateAction {
  type: "SET_OAUTH_STATE";
  payload: {
    providerId: string;
    providers: OAuthProvider[];
    activeProvider?: string;
    flow?: OAuthFlow | null;
  };
}
interface SetOAuthFlowAction {
  type: "SET_OAUTH_FLOW";
  payload: { providerId: string; flow: OAuthFlow };
}
interface SetOAuthFlowsAction {
  type: "SET_OAUTH_FLOWS";
  payload: Record<string, OAuthFlow>;
}
interface SetOAuthCallbackUrlAction {
  type: "SET_OAUTH_CALLBACK_URL";
  payload: { providerId: string; value: string };
}
interface SetOAuthCallbackUrlsAction {
  type: "SET_OAUTH_CALLBACK_URLS";
  payload: Record<string, string>;
}

/* ui slice */
interface SetSidebarOpenAction {
  type: "SET_SIDEBAR_OPEN";
  payload: boolean;
}
interface ToggleSidebarAction {
  type: "TOGGLE_SIDEBAR";
}
interface SetResourceStateAction {
  type: "SET_RESOURCE_STATE";
  payload: { key: string; state: ResourceState };
}

export type Action =
  /* cross-cutting */
  | ResetSessionAction
  | BeginBusyAction
  | EndBusyAction
  | SetErrorAction
  /* auth */
  | SetUserAction
  /* chat */
  | SetChannelsAction
  | SetActiveViewAction
  | SetActiveChannelIdAction
  | SetMessagesAction
  | SetPrivateMessagesAction
  | SetMessageSyncCursorAction
  | SetMessageHistoryAction
  | PrependMessagesAction
  | SetPendingMessagesAction
  | AddPendingMessageAction
  | ReplaceOptimisticMessageAction
  | RemoveOptimisticMessageAction
  | UpdateOptimisticUploadAction
  | SetAgentStatusAction
  | SetAgentStatusesAction
  | ToggleAgentRunAction
  | SetExpandedAgentRunsAction
  | SetMentionTargetsAction
  | SetTypingUsersAction
  | SetDraftsAction
  | SetDraftAction
  | SetDraftFilesAction
  | RemoveDraftFilesAction
  | AddFailedSendAction
  | RestoreNextFailedSendAction
  | SetPrivateTelegramAction
  | SetPrivateTelegramExpandedAction
  /* knowledge */
  | SetDocumentsAction
  | SetKnowledgeSearchAction
  | SetSelectedDocumentAction
  /* admin */
  | SetUsersAction
  | SetPermissionGroupsAction
  | SetActiveAdminPageAction
  | SetMessageAuditAction
  | PatchMessageAuditAction
  | SetTokenUsageAction
  | SetTokenUsageDaysAction
  | SetSecretsAction
  | SetRuntimesAction
  | SetAgentRuntimeConfigAction
  | SetTelegramConfigAction
  | SetAutoUpdateConfigAction
  | SetBrandingConfigAction
  | SetKnowledgeConfigAction
  | SetKnowledgeStatusAction
  | SetSecurityConfigAction
  | SetOAuthProvidersAction
  | SetOAuthStateAction
  | SetOAuthFlowAction
  | SetOAuthFlowsAction
  | SetOAuthCallbackUrlAction
  | SetOAuthCallbackUrlsAction
  /* ui */
  | SetSidebarOpenAction
  | ToggleSidebarAction
  | SetResourceStateAction;

/** Discriminated-union helper: the action for a given `type`. */
export type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;
