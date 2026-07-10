/* Root reducer — composes slice reducers for ordinary actions. RESET_SESSION is
   intentionally handled here as a full-tree ownership boundary so new fields
   cannot accidentally survive an account switch. */

import type { Action, AppState } from "../types";
import { adminInitial, adminReducer } from "./slices/admin";
import { authInitial, authReducer } from "./slices/auth";
import { chatInitial, chatReducer } from "./slices/chat";
import { knowledgeInitial, knowledgeReducer } from "./slices/knowledge";
import { uiInitial, uiReducer } from "./slices/ui";

export const initialAppState: AppState = {
  ...authInitial,
  ...chatInitial,
  ...knowledgeInitial,
  ...adminInitial,
  ...uiInitial,
};

export function rootReducer(state: AppState, action: Action): AppState {
  // A session boundary is an ownership boundary. Reset the complete tree in one
  // atomic transition so a slice added later cannot accidentally retain data
  // from the previous account.
  if (action.type === "RESET_SESSION") {
    return {
      ...initialAppState,
      agentStatuses: { channels: {}, private: null },
      drafts: {},
      draftFiles: {},
      expandedAgentRuns: {},
      knowledgeSearch: { query: "", results: null },
      messageAudit: {
        auditChannelId: null,
        channelMessages: [],
        channelTotal: 0,
        privateConversations: [],
        auditPrivateUserId: null,
        privateMessages: [],
        privateTotal: 0,
      },
      oauthFlows: {},
      oauthCallbackUrls: {},
      pendingOperations: [],
    };
  }
  let next = state;
  next = authReducer(next, action);
  next = chatReducer(next, action);
  next = knowledgeReducer(next, action);
  next = adminReducer(next, action);
  next = uiReducer(next, action);
  return next;
}
