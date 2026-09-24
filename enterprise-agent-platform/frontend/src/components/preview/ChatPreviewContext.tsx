import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { AgentPreviewScope, ComputerMode } from "../../types";
import type { ComputerSurface } from "./computer";

export interface ChatPreviewContextValue {
  scope: AgentPreviewScope | null;
  capabilityActions: ReactNode;
  browserDrawerOpen: boolean;
  computerDrawerOpen: boolean;
  computerMode: ComputerMode | null;
  computerSurface: ComputerSurface | null;
  openComputer: (mode?: ComputerMode, opener?: HTMLElement | null) => void;
  openBrowserAssist: (opener?: HTMLElement | null) => void;
  /** Hidden before any observed work or after dismissal; only new live work clears it. */
  computerPipDismissed: boolean;
  dismissComputerPip: () => void;
}

export const ChatPreviewContext = createContext<ChatPreviewContextValue | null>(null);

export function useChatPreviewContext(): ChatPreviewContextValue | null {
  return useContext(ChatPreviewContext);
}
