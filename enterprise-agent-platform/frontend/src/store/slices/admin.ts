/* Admin slice — accounts, permission groups, audit, token usage, secrets,
   runtimes, configuration and OAuth state. */

import type { Action, AdminSliceState, AppState, MessageAudit } from "../../types";

export const initialMessageAudit: MessageAudit = {
  auditChannelId: null,
  channelMessages: [],
  channelTotal: 0,
  privateConversations: [],
  auditPrivateUserId: null,
  privateMessages: [],
  privateTotal: 0,
};

export const adminInitial: AdminSliceState = {
  users: [],
  permissionGroups: [],
  activeAdminPage: "accounts",
  messageAudit: initialMessageAudit,
  tokenUsage: null,
  tokenUsageDays: 30,
  secrets: [],
  runtimes: null,
  agentRuntimeConfig: null,
  telegramConfig: null,
  autoUpdateConfig: null,
  brandingConfig: null,
  knowledgeConfig: null,
  knowledgeStatus: null,
  securityConfig: null,
  oauthProviders: null,
  oauthFlows: {},
  oauthCallbackUrls: {},
};

export function adminReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_USERS":
      return { ...state, users: action.payload };
    case "SET_PERMISSION_GROUPS":
      return { ...state, permissionGroups: action.payload };
    case "SET_ACTIVE_ADMIN_PAGE":
      return { ...state, activeAdminPage: action.payload };
    case "SET_MESSAGE_AUDIT":
      return { ...state, messageAudit: action.payload };
    case "PATCH_MESSAGE_AUDIT":
      return { ...state, messageAudit: { ...state.messageAudit, ...action.payload } };
    case "SET_TOKEN_USAGE":
      return { ...state, tokenUsage: action.payload };
    case "SET_TOKEN_USAGE_DAYS":
      return { ...state, tokenUsageDays: action.payload };
    case "SET_SECRETS":
      return { ...state, secrets: action.payload };
    case "SET_RUNTIMES":
      return { ...state, runtimes: action.payload };
    case "SET_AGENT_RUNTIME_CONFIG":
      return { ...state, agentRuntimeConfig: action.payload };
    case "SET_TELEGRAM_CONFIG":
      return { ...state, telegramConfig: action.payload };
    case "SET_AUTO_UPDATE_CONFIG":
      return { ...state, autoUpdateConfig: action.payload };
    case "SET_BRANDING_CONFIG":
      return { ...state, brandingConfig: action.payload };
    case "SET_KNOWLEDGE_CONFIG":
      return { ...state, knowledgeConfig: action.payload };
    case "SET_KNOWLEDGE_STATUS":
      return { ...state, knowledgeStatus: action.payload };
    case "SET_SECURITY_CONFIG":
      return { ...state, securityConfig: action.payload };
    case "SET_OAUTH_PROVIDERS":
      return { ...state, oauthProviders: action.payload };
    case "SET_OAUTH_STATE": {
      // Replace oauthProviders with { providers, active_provider }, and merge the flow
      // (keyed by providerId) only when one is present. Completed flows are
      // never deleted here — they linger (driving the "验证完成" banner) until the
      // next full loadOAuthProviders.
      const { providerId, providers, activeProvider, flow } = action.payload;
      const oauthProviders = {
        providers: providers || [],
        active_provider: activeProvider || providerId,
      };
      if (flow) {
        return {
          ...state,
          oauthProviders,
          oauthFlows: { ...state.oauthFlows, [providerId]: flow },
        };
      }
      return { ...state, oauthProviders };
    }
    case "SET_OAUTH_FLOW":
      return {
        ...state,
        oauthFlows: { ...state.oauthFlows, [action.payload.providerId]: action.payload.flow },
      };
    case "SET_OAUTH_FLOWS":
      return { ...state, oauthFlows: action.payload };
    case "SET_OAUTH_CALLBACK_URL":
      return {
        ...state,
        oauthCallbackUrls: {
          ...state.oauthCallbackUrls,
          [action.payload.providerId]: action.payload.value,
        },
      };
    case "SET_OAUTH_CALLBACK_URLS":
      return { ...state, oauthCallbackUrls: action.payload };
    case "RESET_SESSION":
      return { ...state, messageAudit: initialMessageAudit };
    default:
      return state;
  }
}
