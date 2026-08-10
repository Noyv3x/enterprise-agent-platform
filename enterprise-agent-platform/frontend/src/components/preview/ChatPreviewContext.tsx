import { createContext, useContext } from "react";
import type { AgentPreviewScope } from "../../types";

export interface ChatPreviewContextValue {
  scope: AgentPreviewScope | null;
  browserDrawerOpen: boolean;
  openBrowserAssist: () => void;
}

export const ChatPreviewContext = createContext<ChatPreviewContextValue | null>(null);

export function useChatPreviewContext(): ChatPreviewContextValue | null {
  return useContext(ChatPreviewContext);
}
