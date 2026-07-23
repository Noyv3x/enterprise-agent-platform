/* <AppGate> — the boot gate. Runs boot() exactly once (a useRef guard makes it
   StrictMode-double-mount safe), registers the api 401 hook → handleSessionExpired,
   switches between <LoginView/> and <AppShell/> based on the store user.

   The SSE/poll visibility + pagehide lifecycle is NOT here: it lives in the
   useRealtime / usePolling hooks mounted by <AppShell/> (only while a user is
   present), matching the legacy "stop polling/stream when logged out" behavior. */

import { Button } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { registerSessionExpiredHandler } from "../../lib/api";
import { boot, handleSessionExpired } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { LoginView } from "../auth/LoginView";
import { Brand } from "../common/Brand";
import { LanguageSelect } from "../common/LanguageSelect";
import { Spinner } from "../common/Spinner";

const AppShell = lazy(() => import("./AppShell").then((module) => ({ default: module.AppShell })));

function BootScreen({
  status = "loading",
  onRetry,
}: {
  status?: "loading" | "error";
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <main className="auth auth--login">
      <aside className="auth__aside">
        <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
      </aside>
      <div className="auth__main">
        <section
          className="auth__card boot-status"
          role={status === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <div className="auth__locale"><LanguageSelect /></div>
          <Brand />
          <h1>{status === "error" ? t("boot.failed") : t("boot.connecting")}</h1>
          {status === "error" ? (
            <>
              <p className="muted">{t("boot.failedDetail")}</p>
              <Button type="primary" size="large" onClick={onRetry}>
                {t("common.retry")}
              </Button>
            </>
          ) : (
            <div className="boot-status__loading">
              <Spinner size={20} />
              <span>{t("boot.restoringSession")}</span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export function AppGate() {
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const [attempt, setAttempt] = useState(0);
  const [bootStatus, setBootStatus] = useState<"loading" | "ready" | "error">("loading");
  const bootAttempt = useRef(-1);
  const bootPromise = useRef<ReturnType<typeof boot> | null>(null);

  useEffect(() => {
    const unregister = registerSessionExpiredHandler(() => handleSessionExpired(store));
    // Reuse the in-flight promise across StrictMode's development-only effect
    // replay, while a deliberate retry gets a fresh request.
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
    return (
      <BootScreen
        status={bootStatus}
        onRetry={() => {
          setBootStatus("loading");
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  return user ? (
    <Suspense fallback={<BootScreen />}>
      <AppShell />
    </Suspense>
  ) : <LoginView />;
}
