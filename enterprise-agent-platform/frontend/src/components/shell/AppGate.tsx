/* <AppGate> — the boot gate. Runs boot() exactly once (a useRef guard makes it
   StrictMode-double-mount safe), registers the api 401 hook → handleSessionExpired,
   renders <ToastViewport/>, and switches between <LoginView/> and <AppShell/>
   based on the store user.

   The SSE/poll visibility + pagehide lifecycle is NOT here: it lives in the
   useRealtime / usePolling hooks mounted by <AppShell/> (only while a user is
   present), matching the legacy "stop polling/stream when logged out" behavior. */

import { useEffect, useRef, useState } from "react";
import { registerSessionExpiredHandler } from "../../lib/api";
import { ToastViewport } from "../../context/ToastContext";
import { boot, handleSessionExpired } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { LoginView } from "../auth/LoginView";
import { Brand } from "../common/Brand";
import { Spinner } from "../common/Spinner";
import { AppShell } from "./AppShell";

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
      <>
        <ToastViewport />
        <main className="auth">
          <aside className="auth__aside">
            <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
          </aside>
          <div className="auth__main">
            <section
              className="auth__card boot-status"
              role={bootStatus === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              <Brand />
              <h1>{bootStatus === "error" ? "暂时无法连接" : "正在启动"}</h1>
              {bootStatus === "error" ? (
                <>
                  <p className="muted">无法连接企业平台服务，请检查网络后重试。</p>
                  <button
                    className="btn btn--primary btn--lg"
                    type="button"
                    onClick={() => {
                      setBootStatus("loading");
                      setAttempt((value) => value + 1);
                    }}
                  >
                    重试
                  </button>
                </>
              ) : (
                <div className="boot-status__loading">
                  <Spinner size={20} />
                  <span>正在恢复安全会话…</span>
                </div>
              )}
            </section>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <ToastViewport />
      {user ? <AppShell /> : <LoginView />}
    </>
  );
}
