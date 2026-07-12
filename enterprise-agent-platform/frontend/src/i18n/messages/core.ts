import { defineMessages } from "../types";

export const coreMessages = defineMessages({
  "app.title": { "zh-CN": "ubitech agent", en: "ubitech agent", "zh-TW": "ubitech agent" },
  "app.description": {
    "zh-CN": "ubitech agent - 频道协作、私人 Agent、知识库与运行时管理。",
    en: "ubitech agent - channels, private agents, knowledge, and runtime management.",
    "zh-TW": "ubitech agent - 頻道協作、私人 Agent、知識庫與執行環境管理。",
  },
  "language.label": { "zh-CN": "语言", en: "Language", "zh-TW": "語言" },
  "common.retry": { "zh-CN": "重试", en: "Retry", "zh-TW": "重試" },
  "common.reload": { "zh-CN": "重新加载", en: "Reload", "zh-TW": "重新載入" },
  "common.close": { "zh-CN": "关闭", en: "Close", "zh-TW": "關閉" },
  "theme.toggle": { "zh-CN": "切换主题", en: "Switch theme", "zh-TW": "切換主題" },
  "theme.toLight": { "zh-CN": "切换到浅色主题", en: "Switch to light theme", "zh-TW": "切換到淺色主題" },
  "theme.toDark": { "zh-CN": "切换到深色主题", en: "Switch to dark theme", "zh-TW": "切換到深色主題" },
  "auth.login": { "zh-CN": "登录", en: "Sign in", "zh-TW": "登入" },
  "auth.loggingIn": { "zh-CN": "正在登录…", en: "Signing in…", "zh-TW": "正在登入…" },
  "auth.username": { "zh-CN": "用户名", en: "Username", "zh-TW": "使用者名稱" },
  "auth.password": { "zh-CN": "密码", en: "Password", "zh-TW": "密碼" },
  "boot.connecting": { "zh-CN": "正在启动", en: "Starting", "zh-TW": "正在啟動" },
  "boot.failed": { "zh-CN": "暂时无法连接", en: "Unable to connect", "zh-TW": "暫時無法連線" },
  "boot.failedDetail": {
    "zh-CN": "无法连接 ubitech agent 服务，请检查网络后重试。",
    en: "Unable to connect to ubitech agent. Check your network and try again.",
    "zh-TW": "無法連線至 ubitech agent，請檢查網路後重試。",
  },
  "boot.restoringSession": {
    "zh-CN": "正在恢复安全会话…",
    en: "Restoring your secure session…",
    "zh-TW": "正在恢復安全工作階段…",
  },
  "errorBoundary.title": {
    "zh-CN": "页面暂时无法显示",
    en: "This page cannot be displayed",
    "zh-TW": "頁面暫時無法顯示",
  },
  "errorBoundary.detail": {
    "zh-CN": "界面遇到意外错误。刷新后可以安全地重新加载当前会话。",
    en: "The interface encountered an unexpected error. Reload to safely restore the current session.",
    "zh-TW": "介面發生非預期錯誤。重新整理後可安全地載入目前工作階段。",
  },
});
