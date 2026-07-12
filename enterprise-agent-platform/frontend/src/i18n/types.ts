export const SUPPORTED_LOCALES = ["zh-CN", "en", "zh-TW"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export type MessageValue = string | ({ other: string } & Partial<Record<PluralCategory, string>>);

export type MessageDefinition = Record<Locale, MessageValue>;

export type MessageParams = Record<string, string | number>;

export function defineMessages<const T extends Record<string, MessageDefinition>>(messages: T): T {
  return messages;
}
