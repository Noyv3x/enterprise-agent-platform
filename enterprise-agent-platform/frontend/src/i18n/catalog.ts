import { adminMessages } from "./messages/admin";
import { chatMessages } from "./messages/chat";
import { coreMessages } from "./messages/core";
import { workspaceMessages } from "./messages/workspace";

export const messages = {
  ...coreMessages,
  ...adminMessages,
  ...chatMessages,
  ...workspaceMessages,
} as const;

export type MessageKey = keyof typeof messages;
