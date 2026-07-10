import { Component, type ErrorInfo, type ReactNode } from "react";
import { Brand } from "./Brand";

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
    return (
      <main className="auth">
        <aside className="auth__aside">
          <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
        </aside>
        <div className="auth__main">
          <section className="auth__card" role="alert" aria-labelledby="app-error-title">
            <Brand />
            <h1 id="app-error-title">页面暂时无法显示</h1>
            <p className="muted">界面遇到意外错误。刷新后可以安全地重新加载当前会话。</p>
            <button className="btn btn--primary btn--lg" type="button" onClick={() => location.reload()}>
              重新加载
            </button>
          </section>
        </div>
      </main>
    );
  }
}
