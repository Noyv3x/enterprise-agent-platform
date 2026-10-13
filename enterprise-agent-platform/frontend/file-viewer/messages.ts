// The viewer frame has no access to the app's i18n; it follows the browser language (en, zh-CN, zh-TW like the app).
const TEXT = {
  en: { failed: "This file could not be displayed. Download it to open it in Office.", unsupported: "This file type cannot be previewed.", tooLarge: "This file is too large to preview. Download it instead.", sheetHidden: "hidden", truncated: (rows: number, cols: number) => `Showing the first ${rows} rows and ${cols} columns.`, empty: "This sheet is empty.", sheets: "Sheets" },
  "zh-CN": { failed: "无法显示此文件，请下载后用 Office 打开。", unsupported: "此文件类型无法预览。", tooLarge: "文件过大，无法预览，请下载查看。", sheetHidden: "已隐藏", truncated: (rows: number, cols: number) => `仅显示前 ${rows} 行、${cols} 列。`, empty: "此工作表为空。", sheets: "工作表" },
  "zh-TW": { failed: "無法顯示此檔案，請下載後以 Office 開啟。", unsupported: "此檔案類型無法預覽。", tooLarge: "檔案過大，無法預覽，請下載檢視。", sheetHidden: "已隱藏", truncated: (rows: number, cols: number) => `僅顯示前 ${rows} 列、${cols} 欄。`, empty: "此工作表為空。", sheets: "工作表" },
};

export function messages() {
  // The shell's `lang` comes from the app's locale (query parameter); without one the browser's language decides.
  const fromPage = new URLSearchParams(location.search).has("lang") ? document.documentElement.lang : "";
  const language = (fromPage || navigator.language || "en").toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(language)) return TEXT["zh-TW"];
  if (language.startsWith("zh")) return TEXT["zh-CN"];
  return TEXT.en;
}
