/* UI slice — sidebar drawer open state. */

import type { Action, AppState, UiSliceState } from "../../types";

export const uiInitial: UiSliceState = {
  sidebarOpen: false,
  personalAiGuideOpen: false,
  personalAiGuideShownThisSession: false,
  resourceStates: {},
};

export function uiReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_SIDEBAR_OPEN":
      return { ...state, sidebarOpen: action.payload };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "SET_PERSONAL_AI_GUIDE_OPEN":
      return {
        ...state,
        personalAiGuideOpen: action.payload.open,
        personalAiGuideShownThisSession:
          state.personalAiGuideShownThisSession || action.payload.markShown === true,
      };
    case "SET_RESOURCE_STATE":
      return {
        ...state,
        resourceStates: {
          ...state.resourceStates,
          [action.payload.key]: action.payload.state,
        },
      };
    case "RESET_SESSION":
      return { ...state, ...uiInitial };
    default:
      return state;
  }
}
