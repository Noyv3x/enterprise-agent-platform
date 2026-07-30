import { adminMessages } from "./messages/admin";
import { chatMessages } from "./messages/chat";
import { coreMessages } from "./messages/core";
import { workspaceMessages } from "./messages/workspace";
import { previewMessages } from "./messages/preview";
import { scheduledTaskMessages } from "./messages/scheduledTasks";
import { memoryMessages } from "./messages/memory";
import { skillMessages } from "./messages/skills";
import { mailMessages } from "./messages/mail";

export const messages = {
  ...coreMessages,
  ...adminMessages,
  ...chatMessages,
  ...workspaceMessages,
  ...previewMessages,
  ...scheduledTaskMessages,
  ...memoryMessages,
  ...skillMessages,
  ...mailMessages,
} as const;

export type MessageKey = keyof typeof messages;
