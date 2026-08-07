/* Chat slice — channels, view/scope, messages, drafts, agent statuses, mentions,
   typing and private Telegram state. SET_ACTIVE_VIEW redirects users without
   access to admin/private back to a channel; <ContentRouter> handles permission
   changes that occur while a restricted view is open. */

import { hasPermission, isAdmin } from "../selectors";
import { mergeAgentStatus, mergeAgentStatuses } from "../agentStatus";
import { revokeAttachmentUrls } from "../../utils/composerFiles";
import type { Action, AppState, ChatSliceState, Message } from "../../types";

export const chatInitial: ChatSliceState = {
  channels: [],
  activeView: "private",
  activeChannelId: null,
  messages: [],
  privateMessages: [],
  pendingMessages: [],
  drafts: {},
  draftFiles: {},
  failedSends: {},
  messageSyncCursors: {},
  messageHistory: {},
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
    case "SET_MESSAGE_SYNC_CURSOR":
      return {
        ...state,
        messageSyncCursors: {
          ...state.messageSyncCursors,
          [action.payload.key]: action.payload.cursor,
        },
      };
    case "SET_MESSAGE_HISTORY":
      return {
        ...state,
        messageHistory: {
          ...state.messageHistory,
          [action.payload.key]: action.payload.history,
        },
      };
    case "PREPEND_MESSAGES": {
      const { mode, scopeId, messages, nextBeforeId, hasMore } = action.payload;
      const key = `${mode}:${String(scopeId)}`;
      const previousHistory = state.messageHistory[key];
      const prepend = (current: Message[]): Message[] => {
        const existing = new Set(current.map((message) => String(message.id)));
        return [
          ...messages.filter((message) => !existing.has(String(message.id))),
          ...current,
        ];
      };
      const messageHistory = {
        ...state.messageHistory,
        [key]: {
          nextBeforeId,
          hasMore,
          loading: false,
          error: "",
          prependVersion: (previousHistory?.prependVersion || 0) + 1,
        },
      };
      if (mode === "private") {
        return {
          ...state,
          privateMessages: prepend(state.privateMessages),
          messageHistory,
        };
      }
      if (String(state.activeChannelId) === String(scopeId)) {
        return { ...state, messages: prepend(state.messages), messageHistory };
      }
      return { ...state, messageHistory };
    }
    case "SET_PENDING_MESSAGES":
      return { ...state, pendingMessages: action.payload };
    case "SET_AGENT_STATUSES":
      return {
        ...state,
        agentStatuses: mergeAgentStatuses(state.agentStatuses, action.payload),
      };
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
    case "ADD_FAILED_SEND": {
      const previous = state.failedSends[action.payload.key] || [];
      return {
        ...state,
        failedSends: {
          ...state.failedSends,
          [action.payload.key]: [...previous, action.payload.send],
        },
      };
    }
    case "RESTORE_NEXT_FAILED_SEND": {
      const key = action.payload.key;
      const queued = state.failedSends[key] || [];
      if (
        !queued.length ||
        !!state.drafts[key] ||
        !!state.draftFiles[key]?.length
      ) {
        return state;
      }
      const [next, ...remaining] = queued;
      const failedSends = { ...state.failedSends };
      if (remaining.length) failedSends[key] = remaining;
      else delete failedSends[key];
      const draftFiles = { ...state.draftFiles };
      if (next.files.length) draftFiles[key] = next.files;
      else delete draftFiles[key];
      return {
        ...state,
        drafts: { ...state.drafts, [key]: next.content },
        draftFiles,
        failedSends,
      };
    }
    case "SET_PRIVATE_TELEGRAM":
      return { ...state, privateTelegram: action.payload };
    case "SET_PRIVATE_TELEGRAM_EXPANDED":
      return { ...state, privateTelegramExpanded: action.payload };

    /* ------------------------- optimistic message lifecycle ------------------
       The optimistic message object is pushed by
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
        const savedAlreadyPresent = !!saved && list.some((message) => message.id === saved.id);
        const next: Message[] = [];
        for (const message of list) {
          if (message.id !== tempId) {
            next.push(message);
          } else if (saved && !savedAlreadyPresent) {
            // Replace in place so several rapidly sent optimistic bubbles never
            // jump around while their serialized POSTs resolve.
            next.push(saved);
          }
        }
        // The visible scope may have changed or a refresh may have omitted the
        // optimistic row. Append the saved message when replacement is impossible.
        if (
          saved &&
          !savedAlreadyPresent &&
          !next.some((message) => message.id === saved.id)
        ) {
          next.push(saved);
        }
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
    case "UPDATE_OPTIMISTIC_UPLOAD": {
      const { tempId, upload } = action.payload;
      const update = (message: Message): Message =>
        message.id === tempId
          ? {
              ...message,
              metadata: { ...message.metadata, upload },
            }
          : message;
      return {
        ...state,
        pendingMessages: state.pendingMessages.map(update),
        messages: state.messages.map(update),
        privateMessages: state.privateMessages.map(update),
      };
    }

    /* Per-scope Agent status write: no-op on a falsy status; otherwise replace
       just that scope's entry. */
    case "SET_AGENT_STATUS": {
      const { mode, scopeId, status, authoritative } = action.payload;
      if (!status) return state;
      if (mode === "private") {
        return {
          ...state,
          agentStatuses: {
            channels: state.agentStatuses.channels,
            private: mergeAgentStatus(state.agentStatuses.private, status, { authoritative }),
          },
        };
      }
      return {
        ...state,
        agentStatuses: {
          channels: {
            ...state.agentStatuses.channels,
            [String(scopeId)]: mergeAgentStatus(
              state.agentStatuses.channels[String(scopeId)],
              status,
              { authoritative },
            ) || status,
          },
          private: state.agentStatuses.private,
        },
      };
    }

    /* Per-run <details> open/closed memory. */
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
        failedSends: {},
        messageSyncCursors: {},
        messageHistory: {},
        mentionTargets: [],
        typingUsers: [],
      };
    default:
      return state;
  }
}
