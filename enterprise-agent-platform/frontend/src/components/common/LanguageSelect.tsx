import { SUPPORTED_LOCALES, useI18n, type Locale } from "../../i18n";

const LOCALE_NAMES: Record<Locale, string> = {
  "zh-CN": "简体中文",
  en: "English",
  "zh-TW": "繁體中文",
};

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      className="language-select"
      aria-label={t("language.label")}
      title={t("language.label")}
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      {SUPPORTED_LOCALES.map((item) => (
        <option key={item} value={item}>
          {LOCALE_NAMES[item]}
        </option>
      ))}
    </select>
  );
}
