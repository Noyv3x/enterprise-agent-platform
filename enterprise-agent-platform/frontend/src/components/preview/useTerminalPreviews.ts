import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTerminalPreviews } from "../../data/previewActions";
import type { AgentPreviewScope, TerminalPreviewProcess } from "../../types";
import type { PreviewConnection } from "./useBrowserPreview";

// Terminal previews are mounted only while their read-only surface is visible.
// A one-second conditional poll keeps short commands and output tails legible
// without introducing a PTY or a second streaming protocol.
const POLL_INTERVAL_MS = 1_000;

export interface TerminalPreviewsState {
  connection: PreviewConnection;
  loading: boolean;
  processes: TerminalPreviewProcess[];
  error: string;
  capturedAt: string;
  checkedAt: number | null;
  revision: string | null;
}

const initialState: TerminalPreviewsState = {
  connection: "connecting",
  loading: true,
  processes: [],
  error: "",
  capturedAt: "",
  checkedAt: null,
  revision: null,
};

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useTerminalPreviews(scope: AgentPreviewScope | null) {
  const [state, setState] = useState<TerminalPreviewsState>(initialState);
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
    let revision: string | undefined;
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
      inFlight = true;
      controller = new AbortController();
      try {
        const result = await fetchTerminalPreviews(
          scope,
          etag,
          revision,
          controller.signal,
        );
        if (stopped) return;
        const checkedAt = Date.now();
        if (result.etag) etag = result.etag;
        if (result.kind === "unchanged") {
          if (result.revision !== undefined) revision = result.revision;
          setState((current) => ({
            ...current,
            connection: "connected",
            loading: false,
            error: "",
            checkedAt,
            revision: revision ?? current.revision,
          }));
        } else {
          revision = result.revision;
          setState({
            connection: "connected",
            loading: false,
            processes: result.processes || [],
            error: "",
            capturedAt: result.capturedAt || "",
            checkedAt,
            revision: result.revision ?? null,
          });
        }
      } catch (error) {
        if (!stopped && !abortError(error)) {
          setState((current) => ({
            ...current,
            connection: "disconnected",
            loading: false,
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
      if (document.hidden) controller?.abort();
      else if (!inFlight) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(0);

    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      requestNow.current = () => undefined;
    };
  }, [scope?.scope_id, scope?.scope_type]);

  const refresh = useCallback(() => requestNow.current(), []);
  return { state, refresh };
}
