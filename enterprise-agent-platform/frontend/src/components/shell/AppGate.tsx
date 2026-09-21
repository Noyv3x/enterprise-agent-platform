import { Button } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { registerSessionExpiredHandler } from "../../lib/api";
import { boot, handleSessionExpired } from "../../data/sessionActions";
import type { BootResult } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { useBranding } from "../../context/BrandingContext";
import { LoginView } from "../auth/LoginView";
import { LoadingState, RecoveryPage } from "../ui/fieldwork";
import { PublicUtilities } from "../ui/PublicUtilities";

const AppShell = lazy(() => import("./AppShell").then((module) => ({ default: module.AppShell })));

function BootScreen({ status = "loading", onRetry }: { status?: "loading" | "error"; onRetry?: () => void }) {
  const { t } = useI18n();
  const { branding } = useBranding();
  return (
    <RecoveryPage
      brand={{ productName: branding.product_name, logoUrl: branding.logo_url }}
      title={t(status === "error" ? "boot.failed" : "boot.connecting")}
      description={status === "error" ? <div role="alert">{t("boot.failedDetail")}</div> : undefined}
      status={status === "loading" ? <LoadingState label={t("boot.restoringSession")} /> : undefined}
      actions={status === "error" ? <Button type="primary" onClick={onRetry}>{t("common.retry")}</Button> : undefined}
      utilities={<PublicUtilities />}
    />
  );
}

export function AppGate() {
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const [attempt, setAttempt] = useState(0);
  const [bootStatus, setBootStatus] = useState<"loading" | "ready" | "error">("loading");
  const bootAttempt = useRef(-1);
  const bootPromise = useRef<Promise<BootResult> | null>(null);
  useEffect(() => {
    const unregister = registerSessionExpiredHandler(() => handleSessionExpired(store));
    // StrictMode effect replay shares the request; an explicit retry starts a new one.
    if (bootAttempt.current !== attempt) {
      bootAttempt.current = attempt;
      bootPromise.current = boot(store);
    }
    let active = true;
    void bootPromise.current?.then((result) => {
      if (!active) return;
      setBootStatus(result === "error" ? "error" : "ready");
    });
    return () => {
      active = false;
      unregister();
    };
  }, [attempt, store]);

  if (bootStatus !== "ready") {
    return <BootScreen status={bootStatus} onRetry={() => {
      setBootStatus("loading");
      setAttempt((value) => value + 1);
    }} />;
  }
  return user ? <Suspense fallback={<BootScreen />}><AppShell /></Suspense> : <LoginView />;
}
