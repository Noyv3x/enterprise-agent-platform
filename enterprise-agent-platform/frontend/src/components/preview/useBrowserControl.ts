import { useCallback, useEffect, useRef, useState } from "react";
import { acquireBrowserControl, releaseBrowserControl, sendBrowserControlInput, type BrowserControlInput } from "../../data/previewActions";
import { useI18n } from "../../i18n";
import { isApiError } from "../../lib/api";
import { onBrowserControlRelinquish } from "../../lib/browserControl";
import type { AgentPreviewScope } from "../../types";
import { useBrowserPreview } from "./useBrowserPreview";

interface Lease {
  id: string;
  tabId: string;
  scope: AgentPreviewScope;
  expiresAt: number;
  sequence: number;
}

const scopeIdentity = (scope: AgentPreviewScope) => `${scope.scope_type}:${scope.scope_id}`;
const expiry = (duration?: number) => Date.now() + (
  typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 90_000
);

/** All lease side effects, including late-acquire cleanup, share one queue. */
export function useBrowserControl(scope: AgentPreviewScope, clearGesture: () => void) {
  const { t } = useI18n();
  const [lease, setLease] = useState<Lease | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const key = scopeIdentity(scope);
  const { state, refresh } = useBrowserPreview(scope, Boolean(lease && scopeIdentity(lease.scope) === key));
  const current = useRef({ key, tabId: state.tabId });
  current.current = { key, tabId: state.tabId };
  const active = useRef<Lease | null>(null);
  const epoch = useRef(0);
  const acquiring = useRef(false);
  const queue = useRef(Promise.resolve());

  const enqueue = useCallback((operation: () => Promise<void>) => {
    const next = queue.current.then(operation);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const release = useCallback(async (value: Lease) => {
    // Release is best effort: the server remains authoritative for expiry.
    await releaseBrowserControl(value.scope, value.tabId, value.id).catch(() => undefined);
  }, []);

  const endControl = useCallback(() => {
    epoch.current += 1;
    const previous = active.current;
    active.current = null;
    setLease(null);
    clearGesture();
    if (previous) void enqueue(() => release(previous));
    return queue.current;
  }, [clearGesture, enqueue, release]);

  useEffect(() => {
    setControlBusy(acquiring.current);
    return () => { void endControl(); };
  }, [key, state.tabId, endControl]);

  useEffect(() => {
    const blur = () => { void endControl(); };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    const unsubscribe = onBrowserControlRelinquish(scope, endControl);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      unsubscribe();
    };
  }, [key, endControl]);

  useEffect(() => {
    if (!lease) return;
    const timer = setTimeout(() => { void endControl(); }, Math.max(0, lease.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [lease, endControl]);

  const beginControl = useCallback(async () => {
    const { tabId } = current.current;
    if (!tabId || acquiring.current || document.hidden) return;
    void endControl();
    const requestedEpoch = epoch.current;
    const requestedScope = { ...scope };
    acquiring.current = true;
    setControlBusy(true);
    setControlError("");
    await enqueue(async () => {
      try {
        // A queued acquisition cancelled before it starts must not seize control.
        if (epoch.current !== requestedEpoch) return;
        const result = await acquireBrowserControl(requestedScope, tabId);
        if (!result.lease_id) throw new Error(t("browserPreview.controlFailed"));
        const next: Lease = {
          id: result.lease_id, tabId, scope: requestedScope,
          expiresAt: expiry(result.expires_in_ms), sequence: 0,
        };
        if (epoch.current !== requestedEpoch || current.current.key !== key
          || current.current.tabId !== tabId || document.hidden) {
          // Await inside this operation, so send-message handoff also waits for it.
          await release(next);
          return;
        }
        active.current = next;
        setLease(next);
      } catch (error) {
        if (epoch.current === requestedEpoch) {
          setControlError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        acquiring.current = false;
        setControlBusy(false);
      }
    });
  }, [scope.scope_type, scope.scope_id, key, endControl, enqueue, release, t]);

  const sendInput = useCallback((input: BrowserControlInput) => {
    const requested = active.current;
    if (!requested || current.current.key !== scopeIdentity(requested.scope)
      || current.current.tabId !== requested.tabId) return Promise.resolve();
    return enqueue(async () => {
      if (active.current !== requested) return;
      if (Date.now() >= requested.expiresAt) { void endControl(); return; }
      setControlError("");
      try {
        const result = await sendBrowserControlInput(
          requested.scope, requested.tabId, requested.id, ++requested.sequence, input,
        );
        if (active.current !== requested) return;
        requested.expiresAt = expiry(result.expires_in_ms);
        setLease({ ...requested });
        refresh();
      } catch (error) {
        if (active.current !== requested) return;
        if (isApiError(error, 409)) {
          void endControl();
          setControlError(t("browserPreview.controlExpired"));
        } else {
          setControlError(error instanceof Error ? error.message : String(error));
        }
      }
    });
  }, [endControl, enqueue, refresh, t]);

  return {
    state, refresh, controlBusy, controlError, beginControl, endControl, sendInput,
    controlling: Boolean(lease && scopeIdentity(lease.scope) === key && lease.tabId === state.tabId),
  };
}
