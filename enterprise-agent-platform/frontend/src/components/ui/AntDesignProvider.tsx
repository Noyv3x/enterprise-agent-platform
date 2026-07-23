import { ConfigProvider, theme as antTheme } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import zhTW from "antd/es/locale/zh_TW";
import { useMemo, type ReactNode } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTheme } from "../../hooks/useTheme";
import { useI18n, type Locale } from "../../i18n";

const ANT_LOCALES = {
  "zh-CN": zhCN,
  en: enUS,
  "zh-TW": zhTW,
} satisfies Record<Locale, typeof enUS>;

/**
 * Bridges platform-owned theme/i18n state into the component library. Product
 * copy remains in our i18n catalog; Ant Design locale only covers built-in UI.
 */
export function AntDesignProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const { theme } = useTheme();
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const themeConfig = useMemo(() => {
    const palette = theme === "dark"
      ? {
          colorBgContainer: "#191c24",
          colorBgElevated: "#20242d",
          colorFillAlter: "#252a35",
          colorBorder: "#454a56",
          colorBorderSecondary: "#2c303a",
          colorText: "#e5e8ee",
          colorTextSecondary: "#a3a9b4",
        }
      : {
          colorBgContainer: "#ffffff",
          colorBgElevated: "#ffffff",
          colorFillAlter: "#f2f4f7",
          colorBorder: "#c8cdd6",
          colorBorderSecondary: "#dde1e7",
          colorText: "#1b2130",
          colorTextSecondary: "#616978",
        };
    return {
      algorithm: theme === "dark"
        ? [antTheme.darkAlgorithm, antTheme.compactAlgorithm]
        : [antTheme.defaultAlgorithm, antTheme.compactAlgorithm],
      cssVar: { prefix: "eap", key: "platform" },
      hashed: false,
      token: {
        colorPrimary: "#526a9f",
        colorInfo: "#526a9f",
        ...palette,
        borderRadius: 10,
        borderRadiusLG: 12,
        controlHeight: 36,
        controlHeightLG: 44,
        fontSize: 14,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
        motionDurationFast: "0.12s",
        motionDurationMid: "0.18s",
      },
      components: {
        Button: {
          borderRadius: 9,
          controlHeight: 36,
          fontWeight: 600,
        },
        Card: {
          bodyPadding: 20,
        },
        Form: {
          itemMarginBottom: 0,
          verticalLabelPadding: "0 0 6px",
        },
        Menu: {
          activeBarBorderWidth: 0,
          itemBorderRadius: 8,
          itemHeight: 40,
          itemMarginInline: 0,
        },
        Table: {
          cellPaddingBlockMD: 12,
          cellPaddingInlineMD: 16,
          headerBorderRadius: 10,
        },
      },
    };
  }, [theme]);

  return (
    <ConfigProvider
      prefixCls="eap"
      componentSize={coarsePointer ? "large" : "middle"}
      locale={ANT_LOCALES[locale]}
      theme={themeConfig}
    >
      <div className="eap-component-root">{children}</div>
    </ConfigProvider>
  );
}
