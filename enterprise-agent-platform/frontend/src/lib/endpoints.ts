/* =====================================================================
   Single typed source of truth for every backend endpoint: path builder +
   HTTP method + (phantom) request-body / response types. Enumerated verbatim
   from the specs (plan §2.2). Keep paths/methods byte-for-byte.
   ===================================================================== */

import type { Id, ScopeType } from "../types";
import type {
  AuditChannelMessagesResponse,
  AuditPrivateMessagesResponse,
  AuthMeResponse,
  AgentRuntimeConfigResponse,
  AgentRuntimeConfigUpdateRequest,
  AutoUpdateConfigResponse,
  AutoUpdateConfigUpdateRequest,
  AgentApprovalSubmitRequest,
  AgentApprovalSubmitResponse,
  AgentMemoriesExportResponse,
  AgentMemoriesResponse,
  AgentMemoryCandidateDecisionResponse,
  AgentMemoryCandidatesResponse,
  AgentMemoryMutationRequest,
  AgentMemoryMutationResponse,
  AgentPreviewStatusResponse,
  AgentScheduleResponse,
  AgentScheduleRunsResponse,
  AgentScheduleRunNowResponse,
  AgentSchedulesResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ChannelCreateRequest,
  ChannelMessagesResponse,
  ChannelsResponse,
  CogneeConfigResponse,
  CogneeConfigUpdateRequest,
  CreateDocumentRequest,
  CreateUserRequest,
  DeleteBeforeRequest,
  DeleteClearAllRequest,
  DeleteResultResponse,
  DeleteAgentScheduleResponse,
  DeleteAgentMemoryResponse,
  DocumentResponse,
  DocumentsResponse,
  ImpersonateUserResponse,
  KnowledgeSearchResponse,
  LoginRequest,
  LoginResponse,
  MentionTargetsResponse,
  OAuthCompleteRequest,
  OAuthFlowResponse,
  OAuthImportRequest,
  OAuthImportResponse,
  OAuthPollRequest,
  OAuthProvidersResponse,
  PermissionGroupsResponse,
  PostMessageRequest,
  PostMessageResponse,
  PrivateConversationsResponse,
  PrivateMessagesResponse,
  PrivateTelegramResponse,
  PrivateTelegramUpdateRequest,
  RuntimeResponse,
  SecretsResponse,
  SecurityConfigResponse,
  SecurityConfigUpdateRequest,
  SetSecretRequest,
  TelegramConfigResponse,
  TelegramConfigUpdateRequest,
  TokenUsageResponse,
  TerminalPreviewsResponse,
  TypingRequest,
  UpdateCurrentUserRequest,
  UpdateCurrentUserResponse,
  UpdateUserRequest,
  UsersResponse,
} from "../types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** An endpoint descriptor. `Body`/`Res` are phantom (type-only) so the data
 *  layer can derive request/response types from a single declaration. */
export interface Endpoint<Args extends unknown[], Body, Res> {
  method: HttpMethod;
  path: (...args: Args) => string;
  /** phantom — never assigned at runtime; carries the request-body type. */
  readonly __body?: Body;
  /** phantom — never assigned at runtime; carries the response type. */
  readonly __res?: Res;
}

function ep<Body = void, Res = unknown, Args extends unknown[] = []>(
  method: HttpMethod,
  path: (...args: Args) => string,
): Endpoint<Args, Body, Res> {
  return { method, path };
}

/** Bodies sent as the literal string "{}" (legacy empty-POST convention). */
export const EMPTY_BODY = "{}";

export const endpoints = {
  /* auth */
  authMe: ep<void, AuthMeResponse>("GET", () => "/api/auth/me"),
  updateCurrentUser: ep<UpdateCurrentUserRequest, UpdateCurrentUserResponse>(
    "PUT",
    () => "/api/auth/me",
  ),
  changePassword: ep<ChangePasswordRequest, ChangePasswordResponse>(
    "PUT",
    () => "/api/auth/password",
  ),
  login: ep<LoginRequest, LoginResponse>("POST", () => "/api/auth/login"),
  logout: ep<void, unknown>("POST", () => "/api/auth/logout"),

  /* channels */
  channels: ep<void, ChannelsResponse>("GET", () => "/api/channels"),
  createChannel: ep<ChannelCreateRequest, unknown>("POST", () => "/api/channels"),
  channelMessages: ep<void, ChannelMessagesResponse, [Id]>(
    "GET",
    (id) => `/api/channels/${id}/messages`,
  ),
  postChannelMessage: ep<PostMessageRequest | FormData, PostMessageResponse, [Id]>(
    "POST",
    (id) => `/api/channels/${id}/messages`,
  ),
  channelTyping: ep<TypingRequest, unknown, [Id]>(
    "POST",
    (id) => `/api/channels/${id}/typing`,
  ),
  channelAgentApproval: ep<AgentApprovalSubmitRequest, AgentApprovalSubmitResponse, [Id]>(
    "POST",
    (id) => `/api/channels/${id}/agent-approval`,
  ),
  channelEvents: ep<void, never, [Id]>("GET", (id) => `/api/channels/${id}/events`),

  /* private agent */
  privateMessages: ep<void, PrivateMessagesResponse>(
    "GET",
    () => "/api/private-agent/messages",
  ),
  postPrivateMessage: ep<PostMessageRequest | FormData, PostMessageResponse>(
    "POST",
    () => "/api/private-agent/messages",
  ),
  privateAgentApproval: ep<AgentApprovalSubmitRequest, AgentApprovalSubmitResponse>(
    "POST",
    () => "/api/private-agent/agent-approval",
  ),
  privateEvents: ep<void, never>("GET", () => "/api/private-agent/events"),
  privateTelegram: ep<void, PrivateTelegramResponse>(
    "GET",
    () => "/api/private-agent/telegram",
  ),
  updatePrivateTelegram: ep<PrivateTelegramUpdateRequest, PrivateTelegramResponse>(
    "PUT",
    () => "/api/private-agent/telegram",
  ),
  deletePrivateTelegram: ep<string, unknown>("DELETE", () => "/api/private-agent/telegram"),

  /* private Agent schedules */
  privateSchedules: ep<void, AgentSchedulesResponse>(
    "GET",
    () => "/api/private-agent/schedules",
  ),
  privateSchedule: ep<void, AgentScheduleResponse, [Id]>(
    "GET",
    (id) => `/api/private-agent/schedules/${encodeURIComponent(String(id))}`,
  ),
  privateScheduleRuns: ep<void, AgentScheduleRunsResponse, [Id, number, Id?]>(
    "GET",
    (id, limit, beforeId) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (beforeId != null && String(beforeId)) params.set("before_id", String(beforeId));
      return `/api/private-agent/schedules/${encodeURIComponent(String(id))}/runs?${params.toString()}`;
    },
  ),
  pausePrivateSchedule: ep<void, AgentScheduleResponse, [Id]>(
    "POST",
    (id) => `/api/private-agent/schedules/${encodeURIComponent(String(id))}/pause`,
  ),
  resumePrivateSchedule: ep<void, AgentScheduleResponse, [Id]>(
    "POST",
    (id) => `/api/private-agent/schedules/${encodeURIComponent(String(id))}/resume`,
  ),
  runPrivateScheduleNow: ep<void, AgentScheduleRunNowResponse, [Id]>(
    "POST",
    (id) => `/api/private-agent/schedules/${encodeURIComponent(String(id))}/run-now`,
  ),
  deletePrivateSchedule: ep<void, DeleteAgentScheduleResponse, [Id]>(
    "DELETE",
    (id) => `/api/private-agent/schedules/${encodeURIComponent(String(id))}`,
  ),

  /* private Agent durable memory */
  privateAgentMemories: ep<void, AgentMemoriesResponse, [string, string, number]>(
    "GET",
    (target, query, limit) => {
      const params = new URLSearchParams({ target, limit: String(limit) });
      if (query) params.set("q", query);
      return `/api/private-agent/memories?${params.toString()}`;
    },
  ),
  createPrivateAgentMemory: ep<AgentMemoryMutationRequest, AgentMemoryMutationResponse>(
    "POST",
    () => "/api/private-agent/memories",
  ),
  updatePrivateAgentMemory: ep<AgentMemoryMutationRequest, AgentMemoryMutationResponse, [Id]>(
    "PATCH",
    (id) => `/api/private-agent/memories/${encodeURIComponent(String(id))}`,
  ),
  deletePrivateAgentMemory: ep<void, DeleteAgentMemoryResponse, [Id]>(
    "DELETE",
    (id) => `/api/private-agent/memories/${encodeURIComponent(String(id))}`,
  ),
  clearPrivateAgentMemories: ep<void, DeleteAgentMemoryResponse, [string]>(
    "DELETE",
    (target) => {
      const params = new URLSearchParams({ target });
      return `/api/private-agent/memories?${params.toString()}`;
    },
  ),
  exportPrivateAgentMemories: ep<void, AgentMemoriesExportResponse>(
    "GET",
    () => "/api/private-agent/memories/export",
  ),
  privateAgentMemoryCandidates: ep<void, AgentMemoryCandidatesResponse, [string, number]>(
    "GET",
    (status, limit) => {
      const params = new URLSearchParams({ status, limit: String(limit) });
      return `/api/private-agent/memory-candidates?${params.toString()}`;
    },
  ),
  approvePrivateAgentMemoryCandidate: ep<void, AgentMemoryCandidateDecisionResponse, [Id]>(
    "POST",
    (id) => `/api/private-agent/memory-candidates/${encodeURIComponent(String(id))}/approve`,
  ),
  rejectPrivateAgentMemoryCandidate: ep<void, AgentMemoryCandidateDecisionResponse, [Id]>(
    "POST",
    (id) => `/api/private-agent/memory-candidates/${encodeURIComponent(String(id))}/reject`,
  ),

  /* read-only Agent previews */
  previewStatus: ep<void, AgentPreviewStatusResponse, [ScopeType, Id]>(
    "GET",
    (scopeType, scopeId) => {
      const params = new URLSearchParams({ scope_type: scopeType, scope_id: String(scopeId) });
      return `/api/agent-previews/status?${params.toString()}`;
    },
  ),
  browserPreview: ep<void, Response, [ScopeType, Id, string?]>(
    "GET",
    (scopeType, scopeId, tabId) => {
      const params = new URLSearchParams({ scope_type: scopeType, scope_id: String(scopeId) });
      if (tabId) params.set("tab_id", tabId);
      return `/api/agent-previews/browser?${params.toString()}`;
    },
  ),
  terminalPreviews: ep<void, TerminalPreviewsResponse, [ScopeType, Id]>(
    "GET",
    (scopeType, scopeId) => {
      const params = new URLSearchParams({ scope_type: scopeType, scope_id: String(scopeId) });
      return `/api/agent-previews/terminals?${params.toString()}`;
    },
  ),

  /* mentions */
  mentionTargets: ep<void, MentionTargetsResponse>("GET", () => "/api/mention-targets"),

  /* knowledge */
  knowledgeDocuments: ep<void, DocumentsResponse>("GET", () => "/api/knowledge/documents"),
  createKnowledgeDocument: ep<CreateDocumentRequest, unknown>(
    "POST",
    () => "/api/knowledge/documents",
  ),
  knowledgeSearch: ep<void, KnowledgeSearchResponse, [string]>(
    "GET",
    (query) => `/api/knowledge/search?q=${encodeURIComponent(query)}`,
  ),
  knowledgeDocument: ep<void, DocumentResponse, [Id]>(
    "GET",
    (id) => `/api/knowledge/documents/${id}`,
  ),

  /* users + permission groups */
  users: ep<void, UsersResponse>("GET", () => "/api/users"),
  createUser: ep<CreateUserRequest, unknown>("POST", () => "/api/users"),
  updateUser: ep<UpdateUserRequest, unknown, [Id]>("PUT", (id) => `/api/users/${id}`),
  impersonateUser: ep<void, ImpersonateUserResponse, [Id]>(
    "POST",
    (id) => `/api/users/${id}/impersonate`,
  ),
  permissionGroups: ep<void, PermissionGroupsResponse>(
    "GET",
    () => "/api/permission-groups",
  ),

  /* admin: message audit */
  auditChannelMessages: ep<void, AuditChannelMessagesResponse, [Id]>(
    "GET",
    (channelId) => `/api/admin/channels/${channelId}/messages?limit=200`,
  ),
  deleteChannelMessage: ep<string, DeleteResultResponse, [Id, Id]>(
    "DELETE",
    (channelId, messageId) => `/api/admin/channels/${channelId}/messages/${messageId}`,
  ),
  deleteChannelMessages: ep<
    DeleteBeforeRequest | DeleteClearAllRequest,
    DeleteResultResponse,
    [Id]
  >("DELETE", (channelId) => `/api/admin/channels/${channelId}/messages`),
  privateConversations: ep<void, PrivateConversationsResponse>(
    "GET",
    () => "/api/admin/private-agent/conversations",
  ),
  auditPrivateMessages: ep<void, AuditPrivateMessagesResponse, [Id]>(
    "GET",
    (userId) => `/api/admin/private-agent/conversations/${userId}/messages?limit=200`,
  ),
  deletePrivateMessage: ep<string, DeleteResultResponse, [Id, Id]>(
    "DELETE",
    (userId, messageId) =>
      `/api/admin/private-agent/conversations/${userId}/messages/${messageId}`,
  ),
  deletePrivateMessages: ep<
    DeleteBeforeRequest | DeleteClearAllRequest,
    DeleteResultResponse,
    [Id]
  >("DELETE", (userId) => `/api/admin/private-agent/conversations/${userId}/messages`),

  /* admin: token usage */
  tokenUsage: ep<void, TokenUsageResponse, [number | string, number]>(
    "GET",
    (days, limit = 200) =>
      `/api/admin/token-usage?days=${encodeURIComponent(String(days))}&limit=${limit}`,
  ),

  /* settings: secrets */
  secrets: ep<void, SecretsResponse>("GET", () => "/api/settings/secrets"),
  setSecret: ep<SetSecretRequest, unknown, [string]>(
    "PUT",
    (key) => `/api/settings/secrets/${key}`,
  ),

  /* system: runtime */
  runtime: ep<void, RuntimeResponse>("GET", () => "/api/system/runtime"),
  restartRuntime: ep<string, unknown, [string]>(
    "POST",
    (name) => `/api/system/runtime/${name}/restart`,
  ),
  /* system: config */
  securityConfig: ep<void, SecurityConfigResponse>(
    "GET",
    () => "/api/system/security/config",
  ),
  updateSecurityConfig: ep<SecurityConfigUpdateRequest, SecurityConfigResponse>(
    "PUT",
    () => "/api/system/security/config",
  ),
  agentRuntimeConfig: ep<void, AgentRuntimeConfigResponse>(
    "GET",
    () => "/api/system/agent-runtime/config",
  ),
  updateAgentRuntimeConfig: ep<AgentRuntimeConfigUpdateRequest, unknown>(
    "PUT",
    () => "/api/system/agent-runtime/config",
  ),
  telegramConfig: ep<void, TelegramConfigResponse>(
    "GET",
    () => "/api/system/telegram/config",
  ),
  updateTelegramConfig: ep<TelegramConfigUpdateRequest, unknown>(
    "PUT",
    () => "/api/system/telegram/config",
  ),
  autoUpdateConfig: ep<void, AutoUpdateConfigResponse>(
    "GET",
    () => "/api/system/auto-update/config",
  ),
  updateAutoUpdateConfig: ep<AutoUpdateConfigUpdateRequest, unknown>(
    "PUT",
    () => "/api/system/auto-update/config",
  ),
  autoUpdateCheck: ep<string, unknown>("POST", () => "/api/system/auto-update/check"),
  cogneeConfig: ep<void, CogneeConfigResponse>("GET", () => "/api/system/cognee/config"),
  updateCogneeConfig: ep<CogneeConfigUpdateRequest, unknown>(
    "PUT",
    () => "/api/system/cognee/config",
  ),

  /* system: oauth */
  oauthProviders: ep<void, OAuthProvidersResponse>(
    "GET",
    () => "/api/system/oauth/providers",
  ),
  startOAuth: ep<string, OAuthFlowResponse, [string]>(
    "POST",
    (providerId) => `/api/system/oauth/${providerId}/start`,
  ),
  pollOAuth: ep<OAuthPollRequest, OAuthFlowResponse, [string]>(
    "POST",
    (providerId) => `/api/system/oauth/${providerId}/poll`,
  ),
  completeOAuth: ep<OAuthCompleteRequest, OAuthFlowResponse, [string]>(
    "POST",
    (providerId) => `/api/system/oauth/${providerId}/complete`,
  ),
  exportOAuthCredentials: ep<void, unknown>(
    "GET",
    () => "/api/system/oauth/credentials/export",
  ),
  importOAuthCredentials: ep<OAuthImportRequest, OAuthImportResponse>(
    "POST",
    () => "/api/system/oauth/credentials/import",
  ),
} as const;

/** Helper: the request-body type of an endpoint. */
export type BodyOf<E> = E extends Endpoint<infer _A, infer B, infer _R> ? B : never;
/** Helper: the response type of an endpoint. */
export type ResOf<E> = E extends Endpoint<infer _A, infer _B, infer R> ? R : never;
