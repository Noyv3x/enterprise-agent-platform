/* <ThemeToggle/> — the icon button that flips light/dark
   (legacy themeToggle(), legacy-app.js:241-244). */

import { useTheme } from "../../hooks/useTheme";
import { Icon } from "./Icon";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      className="icon-btn"
      type="button"
      title={dark ? "切换到浅色主题" : "切换到深色主题"}
      aria-label="切换主题"
      onClick={toggleTheme}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
