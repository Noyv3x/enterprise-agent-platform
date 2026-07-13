/* =====================================================================
   Shared data constants, copied verbatim from legacy-app.js (66-67, 168-194).
   ===================================================================== */

import type { AdminPage, PermissionGroup, ThinkingDepthOption } from "../types";

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const SSE_RECONNECT_MS = 3000;

export const FALLBACK_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "admin",
    label: "admin",
    description: "admin",
    permissions: [
      "read_workspace",
      "chat",
      "private_agent",
      "manage_channels",
      "manage_knowledge",
      "manage_users",
      "system_settings",
    ],
  },
  {
    id: "manager",
    label: "manager",
    description: "manager",
    permissions: [
      "read_workspace",
      "chat",
      "private_agent",
      "manage_channels",
      "manage_knowledge",
    ],
  },
  {
    id: "member",
    label: "member",
    description: "member",
    permissions: ["read_workspace", "chat", "private_agent"],
  },
  {
    id: "viewer",
    label: "viewer",
    description: "viewer",
    permissions: ["read_workspace"],
  },
];

export const THINKING_DEPTH_OPTIONS: ThinkingDepthOption[] = [
  ["none", "none"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
];

export const ADMIN_PAGES: AdminPage[] = [
  { id: "accounts", label: "accounts", icon: "users", description: "accounts" },
  { id: "tokens", label: "tokens", icon: "barChart", description: "tokens" },
  { id: "messages", label: "messages", icon: "message", description: "messages" },
  { id: "agent-runtime", label: "agent-runtime", icon: "bot", description: "agent-runtime" },
  { id: "telegram", label: "Telegram", icon: "message", description: "telegram" },
  { id: "updates", label: "updates", icon: "refresh", description: "updates" },
  { id: "security", label: "security", icon: "key", description: "security" },
  { id: "runtime", label: "runtime", icon: "server", description: "runtime" },
  { id: "cognee", label: "Cognee", icon: "library", description: "cognee" },
  { id: "secrets", label: "secrets", icon: "key", description: "secrets" },
];
