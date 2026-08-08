import { defineMessages } from "../types";

export const sylverPlatformMessages = defineMessages({
  "sylverPlatform.title": {
    "zh-CN": "Sylver Lining 工作平台",
    en: "Sylver Lining work platform",
    "zh-TW": "Sylver Lining 工作平台",
  },
  "sylverPlatform.description": {
    "zh-CN": "连接你的工作平台账号，让私人 Agent 使用受控工具读取项目资料并提交工作进度。",
    en: "Connect your work-platform account so your Private Agent can read project context and submit progress through controlled tools.",
    "zh-TW": "連接你的工作平台帳戶，讓私人 Agent 使用受控工具讀取專案資料並提交工作進度。",
  },
  "sylverPlatform.baseUrl": {
    "zh-CN": "平台网址",
    en: "Platform URL",
    "zh-TW": "平台網址",
  },
  "sylverPlatform.token": {
    "zh-CN": "Personal API Token",
    en: "Personal API token",
    "zh-TW": "Personal API Token",
  },
  "sylverPlatform.tokenHint": {
    "zh-CN": "Token 只在本次连接时提交，保存后不会再次显示。",
    en: "The token is submitted only for this connection and is never shown again after saving.",
    "zh-TW": "Token 只會在本次連接時提交，儲存後不會再次顯示。",
  },
  "sylverPlatform.connect": {
    "zh-CN": "连接并验证",
    en: "Connect and verify",
    "zh-TW": "連接並驗證",
  },
  "sylverPlatform.reconnect": {
    "zh-CN": "重新连接",
    en: "Reconnect",
    "zh-TW": "重新連接",
  },
  "sylverPlatform.connected": {
    "zh-CN": "已连接",
    en: "Connected",
    "zh-TW": "已連接",
  },
  "sylverPlatform.identity": {
    "zh-CN": "已验证身份",
    en: "Verified identity",
    "zh-TW": "已驗證身份",
  },
  "sylverPlatform.remoteName": {
    "zh-CN": "姓名",
    en: "Name",
    "zh-TW": "姓名",
  },
  "sylverPlatform.username": {
    "zh-CN": "账号",
    en: "Username",
    "zh-TW": "帳號",
  },
  "sylverPlatform.remoteUserId": {
    "zh-CN": "用户 ID",
    en: "User ID",
    "zh-TW": "使用者 ID",
  },
  "sylverPlatform.remoteTitle": {
    "zh-CN": "职位",
    en: "Title",
    "zh-TW": "職位",
  },
  "sylverPlatform.email": {
    "zh-CN": "邮箱",
    en: "Email",
    "zh-TW": "郵箱",
  },
  "sylverPlatform.role": {
    "zh-CN": "角色",
    en: "Role",
    "zh-TW": "角色",
  },
  "sylverPlatform.verifiedAt": {
    "zh-CN": "验证时间",
    en: "Verified at",
    "zh-TW": "驗證時間",
  },
  "sylverPlatform.disconnect": {
    "zh-CN": "断开连接",
    en: "Disconnect",
    "zh-TW": "中斷連接",
  },
  "sylverPlatform.disconnectConfirm": {
    "zh-CN": "断开 Sylver Lining 连接？",
    en: "Disconnect Sylver Lining?",
    "zh-TW": "中斷 Sylver Lining 連接？",
  },
  "sylverPlatform.disconnectConfirmDetail": {
    "zh-CN": "已保存的 Token 和远端身份信息将被删除，Agent 将无法继续使用平台工具。",
    en: "The saved token and remote identity will be removed, and the Agent will no longer be able to use the platform tools.",
    "zh-TW": "已儲存的 Token 和遠端身分資訊將被刪除，Agent 將無法繼續使用平台工具。",
  },
  "sylverPlatform.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
    "zh-TW": "取消",
  },
  "sylverPlatform.loadFailed": {
    "zh-CN": "暂时无法加载工作平台连接。",
    en: "The work-platform connection could not be loaded.",
    "zh-TW": "暫時無法載入工作平台連接。",
  },
  "sylverPlatform.connectFailed": {
    "zh-CN": "连接或身份验证失败，请检查 Token。已有连接（如有）未被更改。",
    en: "Connection or identity verification failed. Check the token. Any existing connection was not changed.",
    "zh-TW": "連接或身分驗證失敗，請檢查 Token。已有連接（如有）未被變更。",
  },
  "sylverPlatform.identityConflict": {
    "zh-CN": "这个远端身份已连接到另一位本地用户。请让原绑定用户先断开连接，或改用属于你的平台 Token。",
    en: "This remote identity is already connected to another local user. Ask that user to disconnect it, or use a platform token that belongs to you.",
    "zh-TW": "這個遠端身分已連接到另一位本機使用者。請讓原綁定使用者先中斷連接，或改用屬於你的平台 Token。",
  },
  "sylverPlatform.disconnectFailed": {
    "zh-CN": "暂时无法断开工作平台连接。",
    en: "The work-platform connection could not be disconnected.",
    "zh-TW": "暫時無法中斷工作平台連接。",
  },
  "sylverPlatform.saved": {
    "zh-CN": "工作平台连接已验证并保存",
    en: "Work-platform connection verified and saved",
    "zh-TW": "工作平台連接已驗證並儲存",
  },
  "sylverPlatform.disconnected": {
    "zh-CN": "工作平台连接已断开",
    en: "Work-platform connection disconnected",
    "zh-TW": "工作平台連接已中斷",
  },
  "sylverPlatform.retry": {
    "zh-CN": "重试",
    en: "Retry",
    "zh-TW": "重試",
  },
  "sylverPlatform.required": {
    "zh-CN": "此项为必填项",
    en: "This field is required",
    "zh-TW": "此欄位為必填項",
  },
  "sylverPlatform.securityNotice": {
    "zh-CN": "Agent 无法看到 Token，也不能发起任意 API 请求；所有操作均通过平台提供的受控工具执行。",
    en: "The Agent cannot see the token or make arbitrary API requests. All actions use controlled platform tools.",
    "zh-TW": "Agent 無法看到 Token，也不能發起任意 API 請求；所有操作均透過平台提供的受控工具執行。",
  },
});
