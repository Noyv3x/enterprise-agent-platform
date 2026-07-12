import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { messages, type MessageKey } from "./catalog";
import { SUPPORTED_LOCALES, type Locale, type MessageParams, type MessageValue } from "./types";

export { SUPPORTED_LOCALES } from "./types";
export type { Locale, MessageParams } from "./types";
export type { MessageKey } from "./catalog";

export const LOCALE_STORAGE_KEY = "eap-locale";

const DEFAULT_LOCALE: Locale = "zh-CN";
let activeLocale: Locale = DEFAULT_LOCALE;

export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function normalizeLocale(raw: unknown): Locale | null {
  const value = String(raw ?? "").trim().replace(/_/g, "-").toLowerCase();
  if (!value) return null;
  if (value === "en" || value.startsWith("en-")) return "en";
  if (
    value === "zh-tw" ||
    value.startsWith("zh-tw-") ||
    value === "zh-hk" ||
    value.startsWith("zh-hk-") ||
    value === "zh-mo" ||
    value.startsWith("zh-mo-") ||
    value === "zh-hant" ||
    value.startsWith("zh-hant-")
  ) {
    return "zh-TW";
  }
  if (value === "zh" || value.startsWith("zh-") || value === "zh-hans" || value.startsWith("zh-hans-")) {
    return "zh-CN";
  }
  return null;
}

export function detectLocale(
  storage: Pick<Storage, "getItem"> | null | undefined,
  languages: readonly string[] = [],
): Locale {
  try {
    const stored = normalizeLocale(storage?.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Storage may be unavailable in private browsing; continue with browser languages.
  }
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

interface BrowserLocaleSource {
  readonly localStorage?: Pick<Storage, "getItem">;
  readonly navigator?: Pick<Navigator, "language" | "languages">;
}

export function detectBrowserLocale(source?: BrowserLocaleSource): Locale {
  const browser = source ?? (typeof window === "undefined" ? undefined : window);
  if (!browser) return DEFAULT_LOCALE;
  let storage: Pick<Storage, "getItem"> | null = null;
  let languages: readonly string[] = [];
  try {
    storage = browser.localStorage || null;
  } catch {
    // Accessing the localStorage property itself may throw in sandboxed contexts.
  }
  try {
    const navigatorValue = browser.navigator;
    languages = navigatorValue?.languages?.length
      ? navigatorValue.languages
      : navigatorValue?.language
        ? [navigatorValue.language]
        : [];
  } catch {
    // A restricted navigator should not prevent the UI from using the default.
  }
  return detectLocale(storage, languages);
}

function messageTemplate(value: MessageValue, locale: Locale, params?: MessageParams): string {
  if (typeof value === "string") return value;
  const count = Number(params?.count);
  if (count === 0 && value.zero) return value.zero;
  const category = Number.isFinite(count) ? new Intl.PluralRules(locale).select(count) : "other";
  return value[category] || value.other;
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const definition = messages[key];
  const value = definition?.[locale] ?? definition?.[DEFAULT_LOCALE];
  return value ? interpolate(messageTemplate(value, locale, params), params) : String(key);
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(activeLocale, key, params);
}

export function getCurrentLocale(): Locale {
  return activeLocale;
}

/** Update the imperative translator without persistence (primarily for tests and SSR). */
export function setCurrentLocale(locale: Locale): void {
  activateLocale(normalizeLocale(locale) || DEFAULT_LOCALE, false);
}

export function intlLocale(locale: Locale = activeLocale): string {
  return locale;
}

interface LocaleDocument {
  documentElement: { lang: string };
  title: string;
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
}

export function applyDocumentLocale(
  locale: Locale,
  target: LocaleDocument | undefined = typeof document === "undefined" ? undefined : document,
): void {
  if (!target) return;
  target.documentElement.lang = locale;
  target.title = translate(locale, "app.title");
  target.querySelector('meta[name="description"]')?.setAttribute("content", translate(locale, "app.description"));
}

function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

function activateLocale(locale: Locale, persist: boolean): void {
  activeLocale = locale;
  applyDocumentLocale(locale);
  if (persist && typeof window !== "undefined") persistLocale(locale);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = detectBrowserLocale();
    activateLocale(initial, false);
    return initial;
  });

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next) || DEFAULT_LOCALE;
    activateLocale(normalized, true);
    setLocaleState(normalized);
  }, []);

  useEffect(() => {
    activateLocale(locale, false);
  }, [locale]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      const next = normalizeLocale(event.newValue);
      if (!next) return;
      activateLocale(next, false);
      setLocaleState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const translateCurrent = useCallback<Translator>((key, params) => translate(locale, key, params), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t: translateCurrent }), [locale, setLocale, translateCurrent]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within an <I18nProvider>");
  return context;
}
