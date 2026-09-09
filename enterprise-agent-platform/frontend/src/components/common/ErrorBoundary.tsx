import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "antd";
import { useI18n } from "../../i18n";
import { useBranding } from "../../context/BrandingContext";
import { RecoveryPage } from "../ui/fieldwork";
import { PublicUtilities } from "../ui/PublicUtilities";

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnostics stay in the console, never in the public recovery surface.
    console.error("Application render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <ErrorFallback />;
  }
}

function ErrorFallback() {
  const { t } = useI18n();
  const { branding } = useBranding();
  return (
    <RecoveryPage
      brand={{ productName: branding.product_name, logoUrl: branding.logo_url }}
      title={t("errorBoundary.title")}
      description={<div role="alert">{t("errorBoundary.detail")}</div>}
      actions={<Button type="primary" onClick={() => location.reload()}>{t("common.reload")}</Button>}
      utilities={<PublicUtilities />}
    />
  );
}
