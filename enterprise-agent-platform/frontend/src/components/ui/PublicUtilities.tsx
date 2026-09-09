import { Button, Space, Tooltip } from "antd";
import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";
import { LanguageSelect } from "../common/LanguageSelect";

export function PublicUtilities() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  return <Space wrap>
    <LanguageSelect />
    <Tooltip title={t("shell.userMenu.theme")}>
      <Button aria-label={t("shell.userMenu.theme")} aria-pressed={theme === "dark"}
        icon={<Icon name={theme === "dark" ? "sun" : "moon"} />} onClick={toggleTheme} />
    </Tooltip>
  </Space>;
}
