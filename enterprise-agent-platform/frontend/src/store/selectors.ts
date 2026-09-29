/* Pure selectors over AppState. Channel/private scope keys depend on the exact
   String() id coercion. No store reads here — callers pass AppState in. */

import { ADMIN_PAGES } from "../lib/constants";
import { t as defaultTranslate, type Translator } from "../i18n";
import type {
  AdminPage,
  AgentStatus,
  AppState,
  Channel,
  ChatMode,
  Id,
  Message,
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

/** Live status wording. A channel names who the Agent is answering; Personal AI has only its owner. */
export function agentStatusText(
  status: AgentStatus | null | undefined,
  mode: ChatMode,
  translate: Translator = defaultTranslate,
): string {
  if (!isAgentActive(status)) return "";
  if (status?.state === "approval") {
    if (mode === "private") return translate("chat.status.approvalSelf");
    return translate("chat.status.approval", {
      target: status.replying_to?.username || translate("chat.userFallback"),
    });
  }
  const inputCount = status?.active_input_group?.message_count || 0;
  if (inputCount > 1) {
    return translate("chat.status.merging", { count: inputCount });
  }
  const queued = status?.state === "queued";
  if (mode === "private") return translate(queued ? "chat.status.queued" : "chat.status.replying");
  const target = status?.replying_to?.username || translate("chat.userFallback");
  return translate(queued ? "chat.status.queuedTo" : "chat.status.replyingTo", { target });
}

/* The Platform's channel trigger (AGENT_MENTION_RE in service.py). Its
   lookbehind becomes a check on the preceding character: Safari before 16.4
   cannot parse lookbehind, and one such literal stops the whole bundle. */
const AGENT_MENTION = /@(?:agent|main-agent|main_agent|main\s+agent)(?![A-Za-z0-9_-])/giu;
const MENTION_BLOCKED_AFTER = /[\p{L}\p{N}_@]$/u;

/** Whether a message reaches the Agent: every Personal AI message, and channel messages that mention it. */
export function requestsAgentReply(mode: ChatMode, content: string | null | undefined): boolean {
  if (mode === "private") return true;
  const text = content || "";
  for (const match of text.matchAll(AGENT_MENTION)) {
    if (!MENTION_BLOCKED_AFTER.test(text.slice(0, match.index))) return true;
  }
  return false;
}

/** The wait a just-sent Agent request shows until the Platform reports its run. It carries the
 *  queued state and reply target of the Platform's first status, so the hand-over keeps the same text. */
export function pendingReplyStatus(mode: ChatMode, messages: readonly Message[]): AgentStatus | null {
  const request = messages.find(
    (message) => message.metadata?.local_pending && requestsAgentReply(mode, message.content),
  );
  return request ? { state: "queued", replying_to: { username: request.username } } : null;
}

/* ----------------------------------------------------------------- admin */

export function activeAdminPage(state: AppState): AdminPage {
  return ADMIN_PAGES.find((page) => page.id === state.activeAdminPage) || ADMIN_PAGES[0];
}

/* --------------------------------------------------------------- topbar */

export function topbarInfo(state: AppState, translate: Translator = defaultTranslate): TopbarInfo {
  if (state.activeView === "private") {
    const active = agentStatusText(agentStatusFor(state, "private"), "private", translate);
    return {
      title: translate("nav.privateAgent"),
      icon: "bot",
      sub: active || translate("nav.topbar.privateSubtitle"),
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
  const active = agentStatusText(agentStatusFor(state, "channel"), "channel", translate);
  return {
    title: ch?.name || translate("nav.channel"),
    hash: true,
    publicChannel: !!ch,
    sub: ch
      ? active || translate("nav.topbar.channelMessages", { count: state.messages.length })
      : translate("nav.topbar.selectChannel"),
  };
}
