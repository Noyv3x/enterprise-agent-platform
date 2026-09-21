/* App — provider stack + lifecycle gates. UpdateGate stays outside the app
   error boundary, toast system, store, and login boot flow so backend
   replacement can always take over an already-open page. */

import { AppGate } from "./components/shell/AppGate";
import { UpdateGate } from "./components/shell/UpdateGate";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { StoreProvider } from "./store/StoreProvider";
import { BeautifulProvider } from "./components/ui/BeautifulProvider";
import { BrandingProvider } from "./context/BrandingContext";

export default function App() {
  return (
    <I18nProvider>
      <BrandingProvider>
        <ThemeProvider>
          <BeautifulProvider>
            <UpdateGate>
              <ErrorBoundary>
                <ToastProvider>
                  <StoreProvider>
                    <AppGate />
                  </StoreProvider>
                </ToastProvider>
              </ErrorBoundary>
            </UpdateGate>
          </BeautifulProvider>
        </ThemeProvider>
      </BrandingProvider>
    </I18nProvider>
  );
}
