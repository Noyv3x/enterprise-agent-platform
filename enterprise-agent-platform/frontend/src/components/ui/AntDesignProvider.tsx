import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import zhTW from "antd/es/locale/zh_TW";
import type { ReactNode } from "react";
import { useBranding } from "../../context/BrandingContext";
import { useTheme } from "../../hooks/useTheme";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useI18n, type Locale } from "../../i18n";
import { FieldworkProvider } from "./fieldwork";

const locales = { "zh-CN": zhCN, en: enUS, "zh-TW": zhTW } satisfies Record<Locale, typeof enUS>;

export function AntDesignProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const { branding } = useBranding();
  const { locale } = useI18n();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const touch = useMediaQuery("(pointer: coarse), (max-width: 639px)");
  return <FieldworkProvider mode={theme} primaryColor={branding.primary_color} locale={locales[locale]} prefixCls="eap" motion={!reducedMotion} touch={touch}>
    {children}
  </FieldworkProvider>;
}
