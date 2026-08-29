import { defineMessages } from "../types";

export const workspaceMessages = defineMessages({
  "toast.complete": { "zh-CN": "完成", en: "Done", "zh-TW": "完成" },
  "toast.operationFailed": { "zh-CN": "操作失败", en: "Operation failed", "zh-TW": "操作失敗" },
  "toast.close": { "zh-CN": "关闭通知", en: "Dismiss notification", "zh-TW": "關閉通知" },

  "resource.loading": { "zh-CN": "正在加载", en: "Loading", "zh-TW": "正在載入" },
  "resource.loadFailed": { "zh-CN": "加载失败", en: "Unable to load", "zh-TW": "載入失敗" },
  "resource.retry": { "zh-CN": "重试", en: "Retry", "zh-TW": "重試" },
  "resource.refreshing": { "zh-CN": "正在刷新…", en: "Refreshing…", "zh-TW": "正在重新整理…" },

  "session.expired": {
    "zh-CN": "会话已过期，请重新登录",
    en: "Your session has expired. Sign in again.",
    "zh-TW": "工作階段已過期，請重新登入",
  },
  "session.loginRequired": { "zh-CN": "需要登录", en: "Sign-in required", "zh-TW": "需要登入" },
  "api.cancelled": { "zh-CN": "请求已取消", en: "Request cancelled", "zh-TW": "請求已取消" },
  "api.timeout": {
    "zh-CN": "请求超时（{count} 秒）",
    en: { one: "Request timed out after {count} second", other: "Request timed out after {count} seconds" },
    "zh-TW": "請求逾時（{count} 秒）",
  },
  "api.failed": {
    "zh-CN": "请求失败（{status}）",
    en: "Request failed ({status})",
    "zh-TW": "請求失敗（{status}）",
  },

  "account.loginRequiredDetail": {
    "zh-CN": "请登录后查看账户设置。",
    en: "Sign in to view account settings.",
    "zh-TW": "請登入後查看帳戶設定。",
  },
  "account.profile": { "zh-CN": "账户资料", en: "Account profile", "zh-TW": "帳戶資料" },
  "account.settingsDescription": {
    "zh-CN": "管理个人资料和登录密码。",
    en: "Manage your profile and sign-in password.",
    "zh-TW": "管理個人資料和登入密碼。",
  },
  "account.identitySummary": {
    "zh-CN": "当前账户",
    en: "Current account",
    "zh-TW": "目前帳戶",
  },
  "account.username": { "zh-CN": "用户名", en: "Username", "zh-TW": "使用者名稱" },
  "account.displayName": { "zh-CN": "显示名称", en: "Display name", "zh-TW": "顯示名稱" },
  "account.position": { "zh-CN": "职位", en: "Position", "zh-TW": "職位" },
  "account.timezone": { "zh-CN": "时区", en: "Time zone", "zh-TW": "時區" },
  "account.timezoneHint": {
    "zh-CN": "使用 IANA 时区名称，例如 Asia/Shanghai。定时任务按此时区显示。",
    en: "Use an IANA time-zone name, such as Asia/Shanghai. Scheduled tasks use this time zone.",
    "zh-TW": "使用 IANA 時區名稱，例如 Asia/Taipei。排程任務會依此時區顯示。",
  },
  "account.saveProfile": { "zh-CN": "保存资料", en: "Save profile", "zh-TW": "儲存資料" },
  "account.saving": { "zh-CN": "保存中…", en: "Saving…", "zh-TW": "儲存中…" },
  "account.changePassword": { "zh-CN": "修改密码", en: "Change password", "zh-TW": "修改密碼" },
  "account.currentPassword": { "zh-CN": "当前密码", en: "Current password", "zh-TW": "目前密碼" },
  "account.newPassword": { "zh-CN": "新密码", en: "New password", "zh-TW": "新密碼" },
  "account.confirmPassword": {
    "zh-CN": "确认新密码",
    en: "Confirm new password",
    "zh-TW": "確認新密碼",
  },
  "account.updatePassword": { "zh-CN": "更新密码", en: "Update password", "zh-TW": "更新密碼" },
  "account.updatingPassword": {
    "zh-CN": "更新中…",
    en: "Updating…",
    "zh-TW": "更新中…",
  },
  "account.passwordMismatch": {
    "zh-CN": "两次输入的新密码不一致",
    en: "The new passwords do not match",
    "zh-TW": "兩次輸入的新密碼不一致",
  },
  "account.passwordMinLength": {
    "zh-CN": "新密码至少 {count} 个字符",
    en: { one: "The new password must be at least {count} character", other: "The new password must be at least {count} characters" },
    "zh-TW": "新密碼至少需要 {count} 個字元",
  },
  "account.profileUpdated": {
    "zh-CN": "账户信息已更新",
    en: "Account information updated",
    "zh-TW": "帳戶資訊已更新",
  },
  "account.passwordUpdated": {
    "zh-CN": "密码已更新",
    en: "Password updated",
    "zh-TW": "密碼已更新",
  },
  "notifications.settings.title": {
    "zh-CN": "浏览器通知",
    en: "Browser notifications",
    "zh-TW": "瀏覽器通知",
  },
  "notifications.settings.replyComplete": {
    "zh-CN": "Agent 回复完成",
    en: "Agent reply completed",
    "zh-TW": "Agent 回覆完成",
  },
  "notifications.settings.description": {
    "zh-CN": "页面保持打开时，如果你切到其它页面，Agent 回复完成后会弹出系统通知。",
    en: "While this page remains open, show a system notification when an Agent finishes replying in the background.",
    "zh-TW": "頁面保持開啟時，若你切換到其他頁面，Agent 回覆完成後會顯示系統通知。",
  },
  "notifications.settings.unsupported": {
    "zh-CN": "当前浏览器或连接不支持系统通知；请使用 HTTPS 访问。",
    en: "System notifications are unavailable in this browser or connection. Use HTTPS.",
    "zh-TW": "目前瀏覽器或連線不支援系統通知；請使用 HTTPS 存取。",
  },
  "notifications.settings.denied": {
    "zh-CN": "浏览器已阻止通知，请在浏览器站点设置中重新允许。",
    en: "Notifications are blocked. Allow them again in your browser's site settings.",
    "zh-TW": "瀏覽器已封鎖通知，請在瀏覽器網站設定中重新允許。",
  },
  "notifications.reply.title": {
    "zh-CN": "{agent} 已回复",
    en: "{agent} replied",
    "zh-TW": "{agent} 已回覆",
  },
  "notifications.reply.body": {
    "zh-CN": "点击返回对话查看回复。",
    en: "Open the conversation to view the reply.",
    "zh-TW": "點擊返回對話查看回覆。",
  },

  "mention.agentDescription": {
    "zh-CN": "呼叫公共频道 Agent",
    en: "Mention the public-channel Agent",
    "zh-TW": "呼叫公共頻道 Agent",
  },
  "oauth.reloginRequired": {
    "zh-CN": "需要重新验证：{message}",
    en: "Sign-in required again: {message}",
    "zh-TW": "需要重新驗證：{message}",
  },
});
