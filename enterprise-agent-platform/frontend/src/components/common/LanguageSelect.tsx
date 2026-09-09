import { Select } from "antd";
import { SUPPORTED_LOCALES, useI18n, type Locale } from "../../i18n";

export const LOCALE_NAMES: Record<Locale, string> = {
  "zh-CN": "简体中文",
  en: "English",
  "zh-TW": "繁體中文",
};
const localeOptions = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }));

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return <Select<Locale>
    aria-label={t("language.label")}
    title={t("language.label")}
    value={locale}
    onChange={setLocale}
    options={localeOptions}
    popupMatchSelectWidth={false}
  />;
}
