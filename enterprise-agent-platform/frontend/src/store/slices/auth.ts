/* Auth slice — user, busy, error. Cross-cutting SET_BUSY/SET_ERROR live here.
   Stubbed for Phase 1: plain setters + the session reset; later phases extend. */

import type { Action, AppState, AuthSliceState } from "../../types";

export const authInitial: AuthSliceState = {
  user: null,
  busy: false,
  error: "",
};

export function authReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_USER":
      return { ...state, user: action.payload };
    case "SET_BUSY":
      return { ...state, busy: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
    case "RESET_SESSION":
      return { ...state, user: null };
    default:
      return state;
  }
}
