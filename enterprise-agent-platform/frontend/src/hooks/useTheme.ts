/* useTheme — read the resolved theme + toggle from ThemeContext. */

import { useContext } from "react";
import { ThemeContext, type ThemeContextValue } from "../context/ThemeContext";

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
