import { defineMessages } from "./types";

/* Keyed messages for code that renders outside React views (document metadata). Views localize inline with
 * `useWords(en, zh-CN, zh-TW)`. */
export const messages = defineMessages({
  "app.description": {
    "zh-CN": "{product} - 公共频道、个人 AI 与运行时管理。",
    en: "{product} - public channels, Personal AI, and runtime management.",
    "zh-TW": "{product} - 公共頻道、個人 AI 與執行環境管理。",
  },
});

export type MessageKey = keyof typeof messages;
