/* ThemeContext keeps CSS attribute-driven: a pinned preference writes <html data-theme> and persists
   localStorage["eap-theme"]; "system" removes both and follows prefers-color-scheme live. Beautiful UI tokens
   switch on the `.dark` class, kept equal to the resolved theme. Theme lives in its own context, so changing it
   never re-renders the store-subscribed tree. */

import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ResolvedTheme = "light" | "dark";
export type ThemePreference = ResolvedTheme | "system";

export const THEME_STORAGE_KEY = "eap-theme";

export interface ThemeContextValue {
  /** what is painted now */
  theme: ResolvedTheme;
  /** what the user chose */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function pinnedTheme(): ResolvedTheme | null {
  const attr = document.documentElement.dataset.theme;
  return attr === "light" || attr === "dark" ? attr : null;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => pinnedTheme() ?? "system");
  const [system, setSystem] = useState<ResolvedTheme>(() => systemTheme());
  const theme = preference === "system" ? system : preference;

  const setPreference = useCallback((next: ThemePreference) => {
    const root = document.documentElement;
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage may be unavailable (private mode); the choice still applies to this page */
    }
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    setPreferenceState(next);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  // Theme changes are not animated: controls with color transitions would pass through mixed, disabled-looking
  // colors. Pin transitions off for the frames in which the new tokens are applied.
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

  const value = useMemo<ThemeContextValue>(() => ({ theme, preference, setPreference }), [theme, preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
