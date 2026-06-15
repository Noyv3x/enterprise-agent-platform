/* <AppGate> — the boot gate. Runs boot() exactly once (a useRef guard makes it
   StrictMode-double-mount safe), registers the api 401 hook → handleSessionExpired,
   renders <ToastViewport/>, and switches between <LoginView/> and <AppShell/>
   based on the store user.

   The SSE/poll visibility + pagehide lifecycle is NOT here: it lives in the
   useRealtime / usePolling hooks mounted by <AppShell/> (only while a user is
   present), matching the legacy "stop polling/stream when logged out" behavior. */

import { useEffect, useRef } from "react";
import { registerSessionExpiredHandler } from "../../lib/api";
import { ToastViewport } from "../../context/ToastContext";
import { boot, handleSessionExpired } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { LoginView } from "../auth/LoginView";
import { AppShell } from "./AppShell";

export function AppGate() {
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const booted = useRef(false);

  useEffect(() => {
    // Wire api()'s 401 hook to the store-aware handler (idempotent set).
    registerSessionExpiredHandler(() => handleSessionExpired(store));
    if (booted.current) return; // StrictMode double-invoke guard
    booted.current = true;
    void boot(store);
  }, [store]);

  return (
    <>
      <ToastViewport />
      {user ? <AppShell /> : <LoginView />}
    </>
  );
}
