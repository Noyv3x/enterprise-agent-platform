import type { ReactNode } from "react";
import { ThemeProvider } from "../context/ThemeContext";
import { I18nProvider } from "../i18n";
import { BeautifulProvider } from "../components/ui/BeautifulProvider";

/** Mirrors the production theme/i18n/component-library provider boundary. */
export function TestUiProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ThemeProvider>
        <BeautifulProvider>{children}</BeautifulProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
