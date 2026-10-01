/* Language and theme choices shared by the login corner, the account menu and Settings. */
import { Icon, Select, type SelectOption } from "../components/ui/beautiful/controls";
import { useTheme } from "../hooks/useTheme";
import { SUPPORTED_LOCALES, useI18n, type Locale } from "../i18n";
import { useWords } from "../words";

/** Each language names itself, so it can be found from any locale. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文", "zh-TW": "繁體中文" };

export const LOCALE_OPTIONS: SelectOption<Locale>[] = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }));

/** Compact language select and light/dark switch for screens without the sidebar (sign-in, boot errors). */
export function PreferenceCorner() {
  const w = useWords();
  const { locale, setLocale } = useI18n();
  const { theme, setPreference } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <div className="flex items-center gap-1.5">
      <Select<Locale> size="sm" aria-label={w("Language", "语言", "語言")} value={locale} options={LOCALE_OPTIONS} onChange={setLocale} className="w-[120px] bg-transparent shadow-none hover:bg-hover-2" />
      <button
        type="button"
        aria-label={next === "dark" ? w("Use dark theme", "使用深色主题", "使用深色主題") : w("Use light theme", "使用浅色主题", "使用淺色主題")}
        onClick={() => setPreference(next)}
        className="flex size-7 items-center justify-center rounded-control text-ink-2 transition-colors duration-150 hover:bg-hover-2 hover:text-ink touch:size-11"
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
      </button>
    </div>
  );
}
