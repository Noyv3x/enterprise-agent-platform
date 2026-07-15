import { defineMessages } from "../types";

export const previewMessages = defineMessages({
  "preview.sidebarLabel": { "zh-CN": "实时预览", en: "Live previews", "zh-TW": "即時預覽" },
  "preview.openBrowser": { "zh-CN": "展开浏览器预览", en: "Open browser preview", "zh-TW": "展開瀏覽器預覽" },
  "preview.openTerminals": {
    "zh-CN": "展开终端预览（{count}）",
    en: { one: "Open terminal preview ({count})", other: "Open terminal previews ({count})" },
    "zh-TW": "展開終端預覽（{count}）",
  },
  "preview.close": { "zh-CN": "关闭预览", en: "Close preview", "zh-TW": "關閉預覽" },
  "preview.readOnly": { "zh-CN": "只读", en: "Read only", "zh-TW": "唯讀" },
  "preview.live": { "zh-CN": "实时", en: "Live", "zh-TW": "即時" },
  "preview.connecting": { "zh-CN": "正在连接", en: "Connecting", "zh-TW": "正在連線" },
  "preview.connected": { "zh-CN": "已连接", en: "Connected", "zh-TW": "已連線" },
  "preview.disconnected": { "zh-CN": "连接中断", en: "Disconnected", "zh-TW": "連線中斷" },
  "preview.waiting": { "zh-CN": "空闲", en: "Idle", "zh-TW": "閒置" },
  "preview.refresh": { "zh-CN": "立即刷新", en: "Refresh now", "zh-TW": "立即重新整理" },
  "preview.updatedAt": { "zh-CN": "更新于 {time}", en: "Updated {time}", "zh-TW": "更新於 {time}" },
  "preview.loadFailed": {
    "zh-CN": "暂时无法获取预览，界面会继续重试。",
    en: "The preview is unavailable. This view will keep retrying.",
    "zh-TW": "暫時無法取得預覽，介面會繼續重試。",
  },
  "preview.frameTooLarge": {
    "zh-CN": "浏览器画面超过预览大小限制。",
    en: "The browser frame exceeds the preview size limit.",
    "zh-TW": "瀏覽器畫面超過預覽大小限制。",
  },

  "browserPreview.title": { "zh-CN": "浏览器实时预览", en: "Live browser preview", "zh-TW": "瀏覽器即時預覽" },
  "browserPreview.description": {
    "zh-CN": "以低帧率查看 Agent 当前浏览器画面；预览无法点击或输入。",
    en: "Watch the Agent's current browser at a low frame rate. The preview cannot be clicked or typed into.",
    "zh-TW": "以低幀率檢視 Agent 目前的瀏覽器畫面；預覽無法點擊或輸入。",
  },
  "browserPreview.frameAlt": { "zh-CN": "Agent 浏览器的最新画面", en: "Latest Agent browser frame", "zh-TW": "Agent 瀏覽器的最新畫面" },
  "browserPreview.loadingFrame": {
    "zh-CN": "正在加载浏览器画面",
    en: "Loading browser view",
    "zh-TW": "正在載入瀏覽器畫面",
  },
  "browserPreview.loadingFrameDetail": {
    "zh-CN": "正在获取最新画面，加载完成后会自动显示。",
    en: "Fetching the latest view. It will appear here automatically when ready.",
    "zh-TW": "正在取得最新畫面，載入完成後會自動顯示。",
  },
  "browserPreview.noBrowser": { "zh-CN": "浏览器尚未运行", en: "Browser is not running", "zh-TW": "瀏覽器尚未執行" },
  "browserPreview.noBrowserDetail": {
    "zh-CN": "Agent 打开浏览器后，画面会自动出现在这里。",
    en: "The picture will appear automatically when the Agent opens a browser.",
    "zh-TW": "Agent 開啟瀏覽器後，畫面會自動出現在這裡。",
  },
  "browserPreview.page": { "zh-CN": "当前页面", en: "Current page", "zh-TW": "目前頁面" },
  "terminalPreview.title": { "zh-CN": "终端实时预览", en: "Live terminal preview", "zh-TW": "終端即時預覽" },
  "terminalPreview.description": {
    "zh-CN": "查看 Agent 当前打开的终端及最新输出；所有终端均为只读。",
    en: "View the Agent's open terminals and latest output. Every terminal is read only.",
    "zh-TW": "檢視 Agent 目前開啟的終端及最新輸出；所有終端均為唯讀。",
  },
  "terminalPreview.count": {
    "zh-CN": "{count} 个终端",
    en: { one: "{count} terminal", other: "{count} terminals" },
    "zh-TW": "{count} 個終端",
  },
  "terminalPreview.noTerminals": { "zh-CN": "当前没有终端", en: "No terminals are open", "zh-TW": "目前沒有終端" },
  "terminalPreview.noTerminalsDetail": {
    "zh-CN": "Agent 使用命令工具后，终端会自动出现在这里。",
    en: "Terminals will appear automatically when the Agent uses command tools.",
    "zh-TW": "Agent 使用命令工具後，終端會自動出現在這裡。",
  },
  "terminalPreview.terminal": { "zh-CN": "终端 {number}", en: "Terminal {number}", "zh-TW": "終端 {number}" },
  "terminalPreview.running": { "zh-CN": "运行中", en: "Running", "zh-TW": "執行中" },
  "terminalPreview.cwd": { "zh-CN": "工作目录", en: "Working directory", "zh-TW": "工作目錄" },
  "terminalPreview.command": { "zh-CN": "命令", en: "Command", "zh-TW": "命令" },
  "terminalPreview.output": { "zh-CN": "只读终端输出", en: "Read-only terminal output", "zh-TW": "唯讀終端輸出" },
  "terminalPreview.emptyOutput": { "zh-CN": "等待终端输出…", en: "Waiting for terminal output…", "zh-TW": "等待終端輸出…" },
  "terminalPreview.truncated": { "zh-CN": "仅显示最新输出", en: "Showing latest output only", "zh-TW": "僅顯示最新輸出" },
});
