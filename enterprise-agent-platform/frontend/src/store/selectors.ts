/* Pure selectors over AppState — ported from the legacy scope/permission/topbar
   helpers (legacy-app.js:349-357, 561-571, 1363-1365, 2783-2873). The exact
   String() id coercion is preserved (channel/private scope keys are coupled to
   it). No store reads here — callers pass AppState in. */

import { ADMIN_PAGES } from "../lib/constants";
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
  return !!status && (status.state === "queued" || status.state === "replying");
}

export function agentStatusText(status: AgentStatus | null | undefined): string {
  if (!isAgentActive(status)) return "";
  const target = status?.replying_to?.username || "用户";
  return status?.state === "queued" ? `Agent 准备回复 ${target}` : `Agent 正在回复 ${target}`;
}

/* ----------------------------------------------------------------- admin */

export function activeAdminPage(state: AppState): AdminPage {
  return ADMIN_PAGES.find((page) => page.id === state.activeAdminPage) || ADMIN_PAGES[0];
}

export function messageAuditState(state: AppState): MessageAudit {
  return state.messageAudit;
}

/* --------------------------------------------------------------- topbar */

export function topbarInfo(state: AppState): TopbarInfo {
  if (state.activeView === "private") {
    const active = agentStatusText(agentStatusFor(state, "private"));
    return { title: "私人 Agent", icon: "bot", sub: active || "仅你可见的私有助手会话" };
  }
  if (state.activeView === "knowledge") {
    return { title: "企业知识库", icon: "library", sub: `${state.documents.length} 篇文档` };
  }
  if (state.activeView === "admin") {
    return { title: "管理面板", icon: "shield", sub: activeAdminPage(state).description };
  }
  const ch = activeChannel(state);
  const active = agentStatusText(agentStatusFor(state, "channel"));
  return {
    title: ch?.name || "频道",
    hash: true,
    sub: ch ? active || `${state.messages.length} 条消息` : "选择或创建一个频道",
  };
}
