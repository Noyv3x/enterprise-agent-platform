/* <ThemeToggle/> — the icon button that flips light/dark
   (legacy themeToggle(), legacy-app.js:241-244). */

import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n";
import { Icon } from "./Icon";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const dark = theme === "dark";
  return (
    <button
      className="icon-btn"
      type="button"
      title={dark ? t("theme.toLight") : t("theme.toDark")}
      aria-label={t("theme.toggle")}
      onClick={toggleTheme}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
