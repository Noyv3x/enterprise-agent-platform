/* App — the provider stack + boot gate (plan §1.2). Theme and Toast are
   orthogonal imperative contexts and sit outside the store; AppGate runs inside
   all three. */

import { AppGate } from "./components/shell/AppGate";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { StoreProvider } from "./store/StoreProvider";

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <StoreProvider>
          <AppGate />
        </StoreProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
