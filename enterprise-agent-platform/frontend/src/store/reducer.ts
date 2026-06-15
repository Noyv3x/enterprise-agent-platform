/* Root reducer — composes the slice reducers. Each slice handles a disjoint set
   of state fields, so chaining them is conflict-free; the cross-cutting
   RESET_SESSION is intentionally handled by several slices (each resetting only
   its own fields). The composed initial AppState is assembled here. */

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
  let next = state;
  next = authReducer(next, action);
  next = chatReducer(next, action);
  next = knowledgeReducer(next, action);
  next = adminReducer(next, action);
  next = uiReducer(next, action);
  return next;
}
