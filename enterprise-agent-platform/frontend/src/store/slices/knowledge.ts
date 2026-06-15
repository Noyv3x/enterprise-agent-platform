/* Knowledge slice — documents, search state, selected document. */

import type { Action, AppState, KnowledgeSliceState } from "../../types";

export const knowledgeInitial: KnowledgeSliceState = {
  documents: [],
  knowledgeSearch: { query: "", results: null },
  selectedDocument: null,
};

export function knowledgeReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_DOCUMENTS":
      return { ...state, documents: action.payload };
    case "SET_KNOWLEDGE_SEARCH":
      return { ...state, knowledgeSearch: action.payload };
    case "SET_SELECTED_DOCUMENT":
      return { ...state, selectedDocument: action.payload };
    case "RESET_SESSION":
      // Drop documents/search/selection on logout or session expiry so a
      // previous user's library + open document never leak into the next
      // session (matches the slice-resets-its-own-fields pattern used across
      // the other slices).
      return { ...state, ...knowledgeInitial };
    default:
      return state;
  }
}
