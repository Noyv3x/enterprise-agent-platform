import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBrowserPreview } from "../../data/previewActions";
import type { AgentPreviewScope } from "../../types";

const POLL_INTERVAL_MS = 2_000;

export type PreviewConnection = "connecting" | "connected" | "disconnected";
export type BrowserPreviewActivity = "loading" | "live" | "idle";

export interface BrowserPreviewState {
  connection: PreviewConnection;
  activity: BrowserPreviewActivity;
  frameUrl: string;
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
  error: "",
  title: "",
  url: "",
  capturedAt: "",
  checkedAt: null,
};

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useBrowserPreview(scope: AgentPreviewScope | null) {
  const [state, setState] = useState<BrowserPreviewState>(initialState);
  const requestNow = useRef<() => void>(() => undefined);

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

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const discardFrame = (clearEtag: boolean) => {
      if (frameUrl) URL.revokeObjectURL(frameUrl);
      frameUrl = "";
      if (clearEtag) etag = "";
    };
    const schedule = (delay = POLL_INTERVAL_MS) => {
      clearTimer();
      if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (stopped || document.hidden || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const result = await fetchBrowserPreview(scope, etag, controller.signal);
        if (stopped) return;
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
        schedule();
      }
    };

    requestNow.current = () => {
      if (!inFlight) schedule(0);
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
          title: "",
          url: "",
          capturedAt: "",
        }));
      } else if (!inFlight) schedule(0);
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

  const refresh = useCallback(() => requestNow.current(), []);
  return { state, refresh };
}
