import { ConfigProvider, theme as antTheme } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import zhTW from "antd/es/locale/zh_TW";
import { useMemo, type ReactNode } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTheme } from "../../hooks/useTheme";
import { useI18n, type Locale } from "../../i18n";
import { useBranding } from "../../context/BrandingContext";

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
  const { branding } = useBranding();
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const themeConfig = useMemo(() => {
    const palette = theme === "dark"
      ? {
          colorBgBase: "#0d0f13",
          colorBgLayout: "#0d0f13",
          colorBgContainer: "#181a20",
          colorBgElevated: "#202229",
          colorFillAlter: "#24272e",
          colorFillSecondary: "#2a2d35",
          colorBorder: "#3a3d46",
          colorBorderSecondary: "#2c2f37",
          colorText: "#f5f5f7",
          colorTextSecondary: "#a1a1a6",
          colorTextTertiary: "#85858b",
        }
      : {
          colorBgBase: "#f5f7fa",
          colorBgLayout: "#f5f7fa",
          colorBgContainer: "#ffffff",
          colorBgElevated: "#ffffff",
          colorFillAlter: "#f1f3f6",
          colorFillSecondary: "#e9ecf1",
          colorBorder: "#d4d8df",
          colorBorderSecondary: "#e3e6eb",
          colorText: "#1d1d1f",
          colorTextSecondary: "#636366",
          colorTextTertiary: "#7c7c82",
        };
    return {
      algorithm: theme === "dark" ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
      cssVar: { prefix: "eap", key: "platform" },
      hashed: false,
      token: {
        colorPrimary: branding.primary_color,
        colorInfo: branding.primary_color,
        ...palette,
        borderRadius: 10,
        borderRadiusLG: 14,
        borderRadiusSM: 8,
        borderRadiusXS: 6,
        controlHeight: 38,
        controlHeightLG: 44,
        controlHeightSM: 32,
        fontSize: 14,
        fontSizeHeading1: 30,
        fontSizeHeading2: 24,
        fontSizeHeading3: 20,
        fontSizeHeading4: 17,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
        lineHeight: 1.5,
        lineWidth: 1,
        motionDurationFast: "0.1s",
        motionDurationMid: "0.18s",
        motionDurationSlow: "0.28s",
        boxShadow: theme === "dark"
          ? "0 10px 32px rgba(0, 0, 0, 0.38)"
          : "0 10px 32px rgba(25, 31, 43, 0.12)",
        boxShadowSecondary: theme === "dark"
          ? "0 18px 56px rgba(0, 0, 0, 0.52)"
          : "0 18px 56px rgba(25, 31, 43, 0.16)",
      },
      components: {
        Button: {
          borderRadius: 10,
          controlHeight: 38,
          fontWeight: 600,
          defaultShadow: "none",
          primaryShadow: "none",
          dangerShadow: "none",
        },
        Card: {
          borderRadiusLG: 16,
          bodyPadding: 22,
          headerHeight: 54,
          headerFontSize: 15,
        },
        Drawer: {
          borderRadiusLG: 18,
          paddingLG: 20,
        },
        Form: {
          itemMarginBottom: 0,
          verticalLabelPadding: "0 0 6px",
        },
        Input: {
          activeShadow: `0 0 0 3px color-mix(in srgb, ${branding.primary_color} 20%, transparent)`,
          paddingBlock: 8,
        },
        Menu: {
          activeBarBorderWidth: 0,
          itemBorderRadius: 10,
          itemHeight: 40,
          itemMarginInline: 0,
        },
        Modal: {
          borderRadiusLG: 20,
          padding: 22,
        },
        Segmented: {
          borderRadius: 10,
          itemSelectedBg: palette.colorBgElevated,
          trackBg: palette.colorFillAlter,
        },
        Table: {
          cellPaddingBlockMD: 12,
          cellPaddingInlineMD: 16,
          headerBorderRadius: 12,
          headerBg: palette.colorFillAlter,
          rowHoverBg: palette.colorFillAlter,
        },
        Tooltip: {
          borderRadius: 8,
        },
      },
    };
  }, [branding.primary_color, theme]);

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
