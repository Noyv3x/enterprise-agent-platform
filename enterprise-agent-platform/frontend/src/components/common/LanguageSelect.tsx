import { Select } from "antd";
import { SUPPORTED_LOCALES, useI18n, type Locale } from "../../i18n";

export const LOCALE_NAMES: Record<Locale, string> = {
  "zh-CN": "简体中文",
  en: "English",
  "zh-TW": "繁體中文",
};

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return (
    <Select
      className="language-select"
      aria-label={t("language.label")}
      title={t("language.label")}
      value={locale}
      onChange={(value) => setLocale(value as Locale)}
      options={SUPPORTED_LOCALES.map((item) => ({ value: item, label: LOCALE_NAMES[item] }))}
      popupMatchSelectWidth={false}
    />
  );
}
