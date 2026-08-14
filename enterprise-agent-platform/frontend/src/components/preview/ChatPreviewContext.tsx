import { createContext, useContext } from "react";
import type { AgentPreviewScope, ComputerMode } from "../../types";
import type { ComputerSurface } from "./computer";

export interface ChatPreviewContextValue {
  scope: AgentPreviewScope | null;
  browserDrawerOpen: boolean;
  computerDrawerOpen: boolean;
  computerMode: ComputerMode | null;
  computerSurface: ComputerSurface | null;
  openComputer: (mode?: ComputerMode) => void;
  openBrowserAssist: () => void;
}

export const ChatPreviewContext = createContext<ChatPreviewContextValue | null>(null);

export function useChatPreviewContext(): ChatPreviewContextValue | null {
  return useContext(ChatPreviewContext);
}
