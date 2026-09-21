import { Button, Tooltip } from "./beautiful";
import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";
import { LanguageSelect } from "../common/LanguageSelect";

export function PublicUtilities() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  return <div className="bui-actions">
    <LanguageSelect />
    <Tooltip title={t("shell.userMenu.theme")}>
      <Button aria-label={t("shell.userMenu.theme")} aria-pressed={theme === "dark"}
        icon={<Icon name={theme === "dark" ? "sun" : "moon"} />} onClick={toggleTheme} />
    </Tooltip>
  </div>;
}
