/* UI slice — sidebar drawer open state. */

import type { Action, AppState, UiSliceState } from "../../types";

export const uiInitial: UiSliceState = {
  sidebarOpen: false,
};

export function uiReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_SIDEBAR_OPEN":
      return { ...state, sidebarOpen: action.payload };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "RESET_SESSION":
      return { ...state, sidebarOpen: false };
    default:
      return state;
  }
}
