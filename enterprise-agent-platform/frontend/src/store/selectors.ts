/* Pure selectors over AppState — ported from the legacy scope/permission/topbar
   helpers (legacy-app.js:349-357, 561-571, 1363-1365, 2783-2873). The exact
   String() id coercion is preserved (channel/private scope keys are coupled to
   it). No store reads here — callers pass AppState in. */

import { ADMIN_PAGES } from "../lib/constants";
import { t as defaultTranslate, type Translator } from "../i18n";
import type {
  AdminPage,
  AgentStatus,
  AppState,
  Channel,
  ChatMode,
  Id,
  MessageAudit,
  ScopeType,
  TopbarInfo,
} from "../types";

/* ----------------------------------------------------------- permissions */

export function userPermissions(state: AppState): Set<string> {
  return new Set(state.user?.permissions || []);
}

export function isAdmin(state: AppState): boolean {
  return (
    state.user?.role === "admin" ||
    state.user?.permission_group === "admin" ||
    userPermissions(state).has("system_settings")
  );
}

export function hasPermission(state: AppState, permission: string): boolean {
  return isAdmin(state) || userPermissions(state).has(permission);
}

export function isOperationPending(state: AppState, operationKey: string): boolean {
  return state.pendingOperations.includes(operationKey);
}

/* --------------------------------------------------------------- scope */

export function activeChannel(state: AppState): Channel | undefined {
  return state.channels.find((channel) => channel.id === state.activeChannelId);
}

export function scopeTypeFor(mode: ChatMode): ScopeType {
  return mode === "private" ? "private" : "channel";
}

export function scopeIdFor(
  state: AppState,
  mode: ChatMode,
  channelId: Id | null = state.activeChannelId,
): string {
  return mode === "private" ? String(state.user?.id || "") : String(channelId || "");
}

export function composerDraftKey(
  state: AppState,
  mode: ChatMode,
  scopeId: string = scopeIdFor(state, mode),
): string {
  return `${scopeTypeFor(mode)}:${scopeId}`;
}

/* --------------------------------------------------------- agent status */

export function agentStatusFor(
  state: AppState,
  mode: ChatMode,
  channelId: Id | null = state.activeChannelId,
): AgentStatus | null {
  if (mode === "private") return state.agentStatuses.private;
  return state.agentStatuses.channels[String(channelId || "")] || null;
}

export function isAgentActive(status: AgentStatus | null | undefined): boolean {
  return !!status && (status.state === "queued" || status.state === "replying" || status.state === "approval");
}

export function agentStatusText(
  status: AgentStatus | null | undefined,
  translate: Translator = defaultTranslate,
): string {
  if (!isAgentActive(status)) return "";
  const target = status?.replying_to?.username || translate("chat.userFallback");
  if (status?.state === "approval") return translate("chat.status.approval", { target });
  const inputCount = status?.active_input_group?.message_count || 0;
  if (inputCount > 1) {
    return translate("chat.status.merging", { count: inputCount });
  }
  return status?.state === "queued"
    ? translate("chat.status.queued", { target })
    : translate("chat.status.replying", { target });
}

/* ----------------------------------------------------------------- admin */

export function activeAdminPage(state: AppState): AdminPage {
  return ADMIN_PAGES.find((page) => page.id === state.activeAdminPage) || ADMIN_PAGES[0];
}

export function messageAuditState(state: AppState): MessageAudit {
  return state.messageAudit;
}

/* --------------------------------------------------------------- topbar */

export function topbarInfo(state: AppState, translate: Translator = defaultTranslate): TopbarInfo {
  if (state.activeView === "private") {
    const active = agentStatusText(agentStatusFor(state, "private"), translate);
    return {
      title: translate("nav.privateAgent"),
      icon: "bot",
      sub: active || translate("nav.topbar.privateSubtitle"),
    };
  }
  if (state.activeView === "knowledge") {
    return {
      title: translate("nav.knowledge"),
      icon: "library",
      sub: translate("nav.topbar.knowledgeDocuments", { count: state.documents.length }),
    };
  }
  if (state.activeView === "admin") {
    return { title: translate("nav.admin"), icon: "shield", sub: translate("nav.topbar.adminSubtitle") };
  }
  if (state.activeView === "settings") {
    return {
      title: translate("nav.settings"),
      icon: "settings",
      sub: translate("nav.topbar.settingsSubtitle"),
    };
  }
  const ch = activeChannel(state);
  const active = agentStatusText(agentStatusFor(state, "channel"), translate);
  return {
    title: ch?.name || translate("nav.channel"),
    hash: true,
    sub: ch
      ? active || translate("nav.topbar.channelMessages", { count: state.messages.length })
      : translate("nav.topbar.selectChannel"),
  };
}
