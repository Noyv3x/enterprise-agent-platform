/* =====================================================================
   Single typed source of truth for every backend endpoint: path builder +
   HTTP method + (phantom) request-body / response types. Enumerated verbatim
   from the specs (plan §2.2). Keep paths/methods byte-for-byte.
   ===================================================================== */

import type { Id } from "../types";
import type {
  AuditChannelMessagesResponse,
  AuditPrivateMessagesResponse,
  AuthMeResponse,
  AutoUpdateConfigResponse,
  AutoUpdateConfigUpdateRequest,
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
  DocumentResponse,
  DocumentsResponse,
  HermesConfigResponse,
  HermesConfigUpdateRequest,
  HermesInternalConfigResponse,
  HermesInternalConfigUpdateRequest,
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
  TypingRequest,
  UpdateUserRequest,
  UsersResponse,
} from "../types";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

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
  privateEvents: ep<void, never>("GET", () => "/api/private-agent/events"),
  privateTelegram: ep<void, PrivateTelegramResponse>(
    "GET",
    () => "/api/private-agent/telegram",
  ),
  updatePrivateTelegram: ep<PrivateTelegramUpdateRequest, unknown>(
    "PUT",
    () => "/api/private-agent/telegram",
  ),
  deletePrivateTelegram: ep<string, unknown>("DELETE", () => "/api/private-agent/telegram"),

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
  installHermes: ep<string, unknown>("POST", () => "/api/system/runtime/hermes/install"),

  /* system: config */
  securityConfig: ep<void, SecurityConfigResponse>(
    "GET",
    () => "/api/system/security/config",
  ),
  updateSecurityConfig: ep<SecurityConfigUpdateRequest, SecurityConfigResponse>(
    "PUT",
    () => "/api/system/security/config",
  ),
  hermesConfig: ep<void, HermesConfigResponse>("GET", () => "/api/system/hermes/config"),
  updateHermesConfig: ep<HermesConfigUpdateRequest, unknown>(
    "PUT",
    () => "/api/system/hermes/config",
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
  hermesInternalConfig: ep<void, HermesInternalConfigResponse>(
    "GET",
    () => "/api/system/hermes/internal-config",
  ),
  updateHermesInternalConfig: ep<HermesInternalConfigUpdateRequest, unknown>(
    "PUT",
    () => "/api/system/hermes/internal-config",
  ),
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
