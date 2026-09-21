import type { ReactNode } from "react";
import { ThemeProvider } from "../context/ThemeContext";
import { I18nProvider } from "../i18n";
import { AntDesignProvider } from "../components/ui/AntDesignProvider";

/** Mirrors the production theme/i18n/component-library provider boundary. */
export function TestUiProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ThemeProvider>
        <AntDesignProvider>{children}</AntDesignProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
