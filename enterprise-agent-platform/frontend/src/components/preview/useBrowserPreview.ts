import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBrowserPreview, type BrowserPreviewResult } from "../../data/previewActions";
import type { AgentPreviewScope } from "../../types";

const READ_ONLY_POLL_MS = 2_000;
const CONTROL_POLL_MS = 250;
const CONTROL_MAX_IDLE_POLL_MS = 1_000;

export type PreviewConnection = "connecting" | "connected" | "disconnected";
export type BrowserPreviewActivity = "loading" | "live" | "idle";

export interface BrowserPreviewState {
  connection: PreviewConnection;
  activity: BrowserPreviewActivity;
  frameUrl: string;
  tabId: string;
  error: string;
  title: string;
  url: string;
  capturedAt: string;
  checkedAt: number | null;
}

const initialState: BrowserPreviewState = {
  connection: "connecting",
  activity: "loading",
  frameUrl: "",
  tabId: "",
  error: "",
  title: "",
  url: "",
  capturedAt: "",
  checkedAt: null,
};

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function boundedServerInterval(result: BrowserPreviewResult, controlling: boolean): number {
  const fallback = controlling ? CONTROL_POLL_MS : READ_ONLY_POLL_MS;
  const requested = result.refreshIntervalMs;
  if (!requested || !Number.isFinite(requested)) return fallback;
  if (controlling) {
    return Math.max(CONTROL_POLL_MS, Math.min(CONTROL_MAX_IDLE_POLL_MS, requested));
  }
  return Math.max(500, Math.min(10_000, requested));
}

export function useBrowserPreview(
  scope: AgentPreviewScope | null,
  controlling = false,
) {
  const [state, setState] = useState<BrowserPreviewState>(initialState);
  const requestNow = useRef<() => void>(() => undefined);
  const controllingRef = useRef(controlling);
  controllingRef.current = controlling;

  useEffect(() => {
    setState(initialState);
    if (!scope) {
      requestNow.current = () => undefined;
      return;
    }

    let stopped = false;
    let inFlight = false;
    let etag = "";
    let frameUrl = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let refreshQueued = false;
    let unchangedCount = 0;
    let lastControlMode = controllingRef.current;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const discardFrame = (clearEtag: boolean) => {
      if (frameUrl) URL.revokeObjectURL(frameUrl);
      frameUrl = "";
      if (clearEtag) etag = "";
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), delay);
    };
    const nextPollDelay = (result: BrowserPreviewResult): number => {
      const controlMode = controllingRef.current;
      if (controlMode !== lastControlMode) {
        lastControlMode = controlMode;
        unchangedCount = 0;
      }
      const base = boundedServerInterval(result, controlMode);
      if (!controlMode) return base;
      if (result.kind === "unchanged") unchangedCount += 1;
      else unchangedCount = 0;
      return Math.min(
        CONTROL_MAX_IDLE_POLL_MS,
        base * (2 ** Math.min(2, unchangedCount)),
      );
    };
    const poll = async () => {
      if (stopped || document.hidden || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      let delay = controllingRef.current ? CONTROL_POLL_MS : READ_ONLY_POLL_MS;
      try {
        const result = await fetchBrowserPreview(scope, etag, controller.signal);
        if (stopped) return;
        delay = nextPollDelay(result);
        const checkedAt = Date.now();
        if (result.kind === "unchanged") {
          setState((current) => ({
            ...current,
            connection: "connected",
            error: "",
            checkedAt,
          }));
        } else if (result.kind === "idle") {
          if (result.etag) etag = result.etag;
          discardFrame(false);
          setState({
            connection: "connected",
            activity: "idle",
            frameUrl: "",
            tabId: "",
            error: "",
            title: "",
            url: "",
            capturedAt: "",
            checkedAt,
          });
        } else {
          if (result.etag) etag = result.etag;
          const nextFrameUrl = URL.createObjectURL(result.blob);
          const previousFrameUrl = frameUrl;
          frameUrl = nextFrameUrl;
          setState({
            connection: "connected",
            activity: "live",
            frameUrl: nextFrameUrl,
            tabId: result.tabId,
            error: "",
            title: result.title,
            url: result.url,
            capturedAt: result.capturedAt,
            checkedAt,
          });
          if (previousFrameUrl) URL.revokeObjectURL(previousFrameUrl);
        }
      } catch (error) {
        if (!stopped && !abortError(error)) {
          setState((current) => ({
            ...current,
            connection: "disconnected",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        inFlight = false;
        controller = null;
        if (refreshQueued) {
          refreshQueued = false;
          unchangedCount = 0;
          schedule(0);
        } else {
          schedule(delay);
        }
      }
    };

    requestNow.current = () => {
      refreshQueued = true;
      unchangedCount = 0;
      if (!inFlight) {
        refreshQueued = false;
        schedule(0);
      }
    };
    const onVisibilityChange = () => {
      clearTimer();
      if (document.hidden) {
        controller?.abort();
        // Release the potentially large frame while it cannot be observed. Clear
        // the validator too, so becoming visible fetches bytes instead of a 304
        // for a blob that no longer exists.
        discardFrame(true);
        setState((current) => ({
          ...current,
          activity: "loading",
          frameUrl: "",
          tabId: "",
          title: "",
          url: "",
          capturedAt: "",
        }));
      } else if (!inFlight) {
        unchangedCount = 0;
        schedule(0);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(0);

    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      requestNow.current = () => undefined;
      discardFrame(true);
    };
  }, [scope?.scope_id, scope?.scope_type]);

  useEffect(() => {
    requestNow.current();
  }, [controlling]);

  const refresh = useCallback(() => requestNow.current(), []);
  return { state, refresh };
}
