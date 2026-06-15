/* ThemeContext — the React port of the legacy theme system
   (currentTheme/toggleTheme, legacy-app.js:230-244).

   CSS stays attribute-driven: we write <html data-theme>, persist
   localStorage["eap-theme"], and resolve "light"/"dark". An UNSET attribute
   means "follow OS"; we ADOPT the improvement of observing matchMedia
   prefers-color-scheme changes while no explicit data-theme is pinned (the
   legacy app only re-rendered on the mobile breakpoint). Theme lives in its own
   context — toggling never re-renders the store-subscribed tree. */

import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  theme: ResolvedTheme;
  toggleTheme: () => void;
}

/** Resolve the active theme: pinned data-theme attribute, else OS preference. */
export function currentTheme(): ResolvedTheme {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ResolvedTheme>(() => currentTheme());

  const toggleTheme = useCallback(() => {
    const next: ResolvedTheme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("eap-theme", next);
    } catch {
      /* storage may be unavailable (private mode); ignore */
    }
    setTheme(next);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      // Follow the OS only while the user has not pinned a theme via the toggle.
      if (!document.documentElement.dataset.theme) {
        setTheme(mq.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ theme, toggleTheme }), [theme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
