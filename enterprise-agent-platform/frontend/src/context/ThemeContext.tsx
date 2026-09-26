/* ThemeContext keeps CSS attribute-driven: it writes <html data-theme>, persists
   localStorage["eap-theme"], and resolve "light"/"dark". An UNSET attribute
   means "follow OS" and observes prefers-color-scheme changes while no explicit
   data-theme is pinned. Theme lives in its own context, so toggling never
   re-renders the store-subscribed tree. */

import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  // Theme changes are not animated: controls with color transitions would pass
  // through mixed, disabled-looking colors. Pin transitions off for the frames
  // in which the new tokens are applied.
  const initialTheme = useRef(theme);
  useLayoutEffect(() => {
    if (initialTheme.current === theme) return;
    initialTheme.current = theme;
    const root = document.documentElement;
    root.dataset.themeSwitching = "";
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => delete root.dataset.themeSwitching);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      delete root.dataset.themeSwitching;
    };
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({ theme, toggleTheme }), [theme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
