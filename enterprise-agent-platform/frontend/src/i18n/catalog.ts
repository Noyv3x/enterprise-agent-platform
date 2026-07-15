import { adminMessages } from "./messages/admin";
import { chatMessages } from "./messages/chat";
import { coreMessages } from "./messages/core";
import { workspaceMessages } from "./messages/workspace";
import { previewMessages } from "./messages/preview";

export const messages = {
  ...coreMessages,
  ...adminMessages,
  ...chatMessages,
  ...workspaceMessages,
  ...previewMessages,
} as const;

export type MessageKey = keyof typeof messages;
