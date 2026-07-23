import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "antd";
import { useI18n } from "../../i18n";
import { Brand } from "./Brand";
import { LanguageSelect } from "./LanguageSelect";

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep diagnostics in the browser console without exposing implementation
    // details or stack traces in the product-facing fallback.
    console.error("Application render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <ErrorFallback />;
  }
}

function ErrorFallback() {
  const { t } = useI18n();
  return (
    <main className="auth">
      <aside className="auth__aside">
        <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
      </aside>
      <div className="auth__main">
        <section className="auth__card" role="alert" aria-labelledby="app-error-title">
          <div className="auth__locale"><LanguageSelect /></div>
          <Brand />
          <h1 id="app-error-title">{t("errorBoundary.title")}</h1>
          <p className="muted">{t("errorBoundary.detail")}</p>
          <Button type="primary" size="large" onClick={() => location.reload()}>
            {t("common.reload")}
          </Button>
        </section>
      </div>
    </main>
  );
}
