/* Chat slice — channels, view/scope, messages, drafts, agent statuses, mentions,
   typing, private-telegram. Phase 1 stubs the plain field setters + the session
   reset; the optimistic-message lifecycle, agent-status writes, and run toggles
   are filled by Phase 4a (default: return state here).

   Phase 3 adds the permission coercion to SET_ACTIVE_VIEW (legacy renderShell
   guard, legacy-app.js:408-409): a user lacking access to admin/private is
   silently redirected to channel. The reactive demotion case (permissions change
   while viewing) is handled by <ContentRouter>'s coercion effect. */

import { hasPermission, isAdmin } from "../selectors";
import { revokeAttachmentUrls } from "../../utils/composerFiles";
import type { Action, AppState, ChatSliceState, Message } from "../../types";

export const chatInitial: ChatSliceState = {
  channels: [],
  activeView: "channel",
  activeChannelId: null,
  messages: [],
  privateMessages: [],
  pendingMessages: [],
  drafts: {},
  draftFiles: {},
  agentStatuses: { channels: {}, private: null },
  expandedAgentRuns: {},
  mentionTargets: [],
  typingUsers: [],
  privateTelegram: null,
  privateTelegramExpanded: false,
};

export function chatReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_CHANNELS":
      return { ...state, channels: action.payload };
    case "SET_ACTIVE_VIEW": {
      let view = action.payload;
      if (!isAdmin(state) && view === "admin") view = "channel";
      if (!hasPermission(state, "private_agent") && view === "private") view = "channel";
      return { ...state, activeView: view };
    }
    case "SET_ACTIVE_CHANNEL_ID":
      return { ...state, activeChannelId: action.payload };
    case "SET_MESSAGES":
      return { ...state, messages: action.payload };
    case "SET_PRIVATE_MESSAGES":
      return { ...state, privateMessages: action.payload };
    case "SET_PENDING_MESSAGES":
      return { ...state, pendingMessages: action.payload };
    case "SET_AGENT_STATUSES":
      return { ...state, agentStatuses: action.payload };
    case "SET_EXPANDED_AGENT_RUNS":
      return { ...state, expandedAgentRuns: action.payload };
    case "SET_MENTION_TARGETS":
      return { ...state, mentionTargets: action.payload };
    case "SET_TYPING_USERS":
      return { ...state, typingUsers: action.payload };
    case "SET_DRAFTS":
      return { ...state, drafts: action.payload };
    case "SET_DRAFT":
      return {
        ...state,
        drafts: { ...state.drafts, [action.payload.key]: action.payload.value },
      };
    case "SET_DRAFT_FILES":
      return {
        ...state,
        draftFiles: { ...state.draftFiles, [action.payload.key]: action.payload.files },
      };
    case "REMOVE_DRAFT_FILES": {
      const next = { ...state.draftFiles };
      delete next[action.payload.key];
      return { ...state, draftFiles: next };
    }
    case "SET_PRIVATE_TELEGRAM":
      return { ...state, privateTelegram: action.payload };
    case "SET_PRIVATE_TELEGRAM_EXPANDED":
      return { ...state, privateTelegramExpanded: action.payload };

    /* ------------------- optimistic message lifecycle (Phase 4a) -------------
       appendOptimisticMessage / replaceOptimisticMessage / removeOptimisticMessage
       (legacy-app.js:2963-3005). The optimistic message object is pushed by
       reference into BOTH pendingMessages and the visible list, so revoking its
       blob: preview URLs once (in the REPLACE/REMOVE transition that drops it)
       frees every attachment. The "only touch the visible list if the scope is
       still active" guard prevents cross-scope leakage on mid-send navigation. */
    case "ADD_PENDING_MESSAGE": {
      const { mode, scopeId, message } = action.payload;
      const pendingMessages = [...state.pendingMessages, message];
      if (mode === "private") {
        return { ...state, pendingMessages, privateMessages: [...state.privateMessages, message] };
      }
      if (String(state.activeChannelId) === String(scopeId)) {
        return { ...state, pendingMessages, messages: [...state.messages, message] };
      }
      return { ...state, pendingMessages };
    }
    case "REPLACE_OPTIMISTIC_MESSAGE": {
      const { mode, scopeId, tempId, saved } = action.payload;
      revokeAttachmentUrls(state.pendingMessages.find((message) => message.id === tempId));
      const pendingMessages = state.pendingMessages.filter((message) => message.id !== tempId);
      const apply = (list: Message[]): Message[] => {
        const next = list.filter((message) => message.id !== tempId);
        // Dedupe guard: a poll/SSE update may have already inserted the saved
        // message before the POST resolved (legacy replaceOptimisticMessage).
        if (saved && !next.some((message) => message.id === saved.id)) next.push(saved);
        return next;
      };
      if (mode === "private") {
        return { ...state, pendingMessages, privateMessages: apply(state.privateMessages) };
      }
      if (String(state.activeChannelId) === String(scopeId)) {
        return { ...state, pendingMessages, messages: apply(state.messages) };
      }
      return { ...state, pendingMessages };
    }
    case "REMOVE_OPTIMISTIC_MESSAGE": {
      const { mode, scopeId, tempId } = action.payload;
      revokeAttachmentUrls(state.pendingMessages.find((message) => message.id === tempId));
      const pendingMessages = state.pendingMessages.filter((message) => message.id !== tempId);
      if (mode === "private") {
        return {
          ...state,
          pendingMessages,
          privateMessages: state.privateMessages.filter((message) => message.id !== tempId),
        };
      }
      if (String(state.activeChannelId) === String(scopeId)) {
        return {
          ...state,
          pendingMessages,
          messages: state.messages.filter((message) => message.id !== tempId),
        };
      }
      return { ...state, pendingMessages };
    }

    /* Per-scope agent-status write (legacy setAgentStatus, :2862-2866): no-op on a
       falsy status; otherwise replace just that scope's entry. */
    case "SET_AGENT_STATUS": {
      const { mode, scopeId, status } = action.payload;
      if (!status) return state;
      if (mode === "private") {
        return {
          ...state,
          agentStatuses: { channels: state.agentStatuses.channels, private: status },
        };
      }
      return {
        ...state,
        agentStatuses: {
          channels: { ...state.agentStatuses.channels, [String(scopeId)]: status },
          private: state.agentStatuses.private,
        },
      };
    }

    /* Per-run <details> open/closed memory (legacy renderAgentWorkCard summary
       onclick, :981-985). */
    case "TOGGLE_AGENT_RUN":
      return {
        ...state,
        expandedAgentRuns: {
          ...state.expandedAgentRuns,
          [action.payload.runId]: action.payload.expanded,
        },
      };

    case "RESET_SESSION":
      return {
        ...state,
        pendingMessages: [],
        draftFiles: {},
        mentionTargets: [],
        typingUsers: [],
      };
    default:
      return state;
  }
}
