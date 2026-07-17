import { adminMessages } from "./messages/admin";
import { chatMessages } from "./messages/chat";
import { coreMessages } from "./messages/core";
import { workspaceMessages } from "./messages/workspace";
import { previewMessages } from "./messages/preview";
import { scheduledTaskMessages } from "./messages/scheduledTasks";

export const messages = {
  ...coreMessages,
  ...adminMessages,
  ...chatMessages,
  ...workspaceMessages,
  ...previewMessages,
  ...scheduledTaskMessages,
} as const;

export type MessageKey = keyof typeof messages;
