import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPreviewAvailability } from "../../data/previewActions";
import type { AgentPreviewScope } from "../../types";

const POLL_INTERVAL_MS = 2_000;

export interface PreviewAvailabilityState {
  browserActive: boolean;
  runningTerminalCount: number;
  loading: boolean;
  error: string;
}

interface StoredPreviewAvailabilityState extends PreviewAvailabilityState {
  scopeKey: string;
}

function scopeKey(scope: AgentPreviewScope | null): string {
  return scope ? `${scope.scope_type}\u0000${scope.scope_id}` : "";
}

function emptyState(key: string, loading: boolean): StoredPreviewAvailabilityState {
  return {
    scopeKey: key,
    browserActive: false,
    runningTerminalCount: 0,
    loading,
    error: "",
  };
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function usePreviewAvailability(scope: AgentPreviewScope | null) {
  const key = scopeKey(scope);
  const [storedState, setStoredState] = useState<StoredPreviewAvailabilityState>(() =>
    emptyState(key, Boolean(scope)),
  );
  const requestNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    setStoredState(emptyState(key, Boolean(scope)));
    if (!scope) {
      requestNow.current = () => undefined;
      return;
    }

    let stopped = false;
    let inFlight = false;
    let generation = 0;
    let etag = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay = POLL_INTERVAL_MS) => {
      clearTimer();
      if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (stopped || document.hidden || inFlight) return;
      const requestGeneration = ++generation;
      const requestController = new AbortController();
      inFlight = true;
      controller = requestController;
      try {
        const result = await fetchPreviewAvailability(scope, etag, requestController.signal);
        if (
          stopped ||
          requestGeneration !== generation ||
          requestController.signal.aborted
        ) return;
        if (result.kind === "unchanged") {
          setStoredState((current) => current.scopeKey === key ? {
            ...current,
            loading: false,
            error: "",
          } : current);
        } else {
          if (result.etag) etag = result.etag;
          setStoredState({
            scopeKey: key,
            browserActive: result.browserActive,
            runningTerminalCount: result.runningTerminalCount,
            loading: false,
            error: "",
          });
        }
      } catch (error) {
        if (
          !stopped &&
          requestGeneration === generation &&
          !requestController.signal.aborted &&
          !abortError(error)
        ) {
          setStoredState((current) => current.scopeKey === key ? {
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          } : current);
        }
      } finally {
        if (requestGeneration === generation) {
          inFlight = false;
          if (controller === requestController) controller = null;
          schedule();
        }
      }
    };

    requestNow.current = () => {
      if (!inFlight) schedule(0);
    };
    const onVisibilityChange = () => {
      clearTimer();
      if (document.hidden) {
        generation += 1;
        controller?.abort();
        controller = null;
        inFlight = false;
      } else {
        schedule(0);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(0);

    return () => {
      stopped = true;
      generation += 1;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      requestNow.current = () => undefined;
    };
  }, [key, scope?.scope_id, scope?.scope_type]);

  // Effects run after render. Gate stored data by the current scope so a scope
  // switch cannot expose the previous scope's availability for even one frame.
  const current = storedState.scopeKey === key
    ? storedState
    : emptyState(key, Boolean(scope));
  const state: PreviewAvailabilityState = {
    browserActive: current.browserActive,
    runningTerminalCount: current.runningTerminalCount,
    loading: current.loading,
    error: current.error,
  };
  const refresh = useCallback(() => requestNow.current(), []);
  return { state, refresh };
}
