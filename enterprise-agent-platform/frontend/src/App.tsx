/* App — the provider stack + boot gate (plan §1.2). Theme and Toast are
   orthogonal imperative contexts and sit outside the store; AppGate runs inside
   all three. */

import { AppGate } from "./components/shell/AppGate";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { StoreProvider } from "./store/StoreProvider";

export default function App() {
  return (
    <I18nProvider>
      <ErrorBoundary>
        <ThemeProvider>
          <ToastProvider>
            <StoreProvider>
              <AppGate />
            </StoreProvider>
          </ToastProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </I18nProvider>
  );
}
