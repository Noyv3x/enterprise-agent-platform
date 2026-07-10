/* Auth slice — user, busy, error. Cross-cutting SET_BUSY/SET_ERROR live here.
   Stubbed for Phase 1: plain setters + the session reset; later phases extend. */

import type { Action, AppState, AuthSliceState } from "../../types";

export const authInitial: AuthSliceState = {
  user: null,
  busy: false,
  pendingOperations: [],
  error: "",
};

export function authReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_USER":
      return { ...state, user: action.payload };
    case "BEGIN_BUSY": {
      if (state.pendingOperations.includes(action.payload)) return state;
      const pendingOperations = [...state.pendingOperations, action.payload];
      return { ...state, pendingOperations, busy: true };
    }
    case "END_BUSY": {
      const pendingOperations = state.pendingOperations.filter((id) => id !== action.payload);
      if (pendingOperations.length === state.pendingOperations.length) return state;
      return { ...state, pendingOperations, busy: pendingOperations.length > 0 };
    }
    case "SET_ERROR":
      return { ...state, error: action.payload };
    case "RESET_SESSION":
      return { ...state, ...authInitial };
    default:
      return state;
  }
}
