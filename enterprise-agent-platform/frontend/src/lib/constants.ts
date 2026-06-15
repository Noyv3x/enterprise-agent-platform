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
    label: "管理员",
    description: "管理企业账户、模型配置和平台运行时。",
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
    label: "经理",
    description: "管理频道和知识库，并使用企业 Agent。",
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
    label: "成员",
    description: "使用频道、知识库和私人 Agent。",
    permissions: ["read_workspace", "chat", "private_agent"],
  },
  {
    id: "viewer",
    label: "只读",
    description: "只能查看频道消息和企业知识。",
    permissions: ["read_workspace"],
  },
];

export const THINKING_DEPTH_OPTIONS: ThinkingDepthOption[] = [
  ["none", "关闭"],
  ["minimal", "极低"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "超高"],
];

export const ADMIN_PAGES: AdminPage[] = [
  { id: "accounts", label: "账户权限", icon: "users", description: "企业账户、权限组与个人模型策略。" },
  { id: "tokens", label: "Token 监控", icon: "barChart", description: "按账户、私聊/频道、供应商和模型查看消耗。" },
  { id: "messages", label: "消息审计", icon: "message", description: "频道消息删除与私人 Agent 会话审计。" },
  { id: "model", label: "模型接入", icon: "shield", description: "OAuth 供应商验证与 Hermes API 参数。" },
  { id: "telegram", label: "Telegram", icon: "message", description: "Telegram 私聊网关与用户绑定状态。" },
  { id: "updates", label: "自动更新", icon: "refresh", description: "监听上游代码提交并自动拉取部署。" },
  { id: "security", label: "公网安全", icon: "key", description: "反向代理、Cookie 与启动安全项。" },
  { id: "runtime", label: "运行时", icon: "server", description: "底层基座服务健康状态。" },
  { id: "hermes", label: "Hermes", icon: "settings", description: "Hermes config.yaml 与环境变量。" },
  { id: "cognee", label: "Cognee", icon: "library", description: "Cognee 环境变量配置。" },
  { id: "secrets", label: "密钥", icon: "key", description: "平台内部密钥。" },
];
