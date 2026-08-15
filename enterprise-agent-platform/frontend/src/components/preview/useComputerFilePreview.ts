import { useCallback, useEffect, useState } from "react";
import { fetchPreviewFile } from "../../data/previewActions";
import type {
  AgentPreviewFileDraftKind,
  AgentPreviewFileSource,
  AgentPreviewScope,
  ComputerFileClue,
} from "../../types";

const PENDING_RETRY_DELAY_MS = 320;
const PENDING_RETRY_LIMIT = 8;

export interface ComputerFilePreviewState {
  content: string;
  previousContent: string | null;
  source: AgentPreviewFileSource;
  draftKind: AgentPreviewFileDraftKind | null;
  revision: string;
  truncated: boolean;
  loading: boolean;
  pending: boolean;
  loaded: boolean;
  error: string;
  snapshot: number;
}

const EMPTY_STATE: ComputerFilePreviewState = {
  content: "",
  previousContent: null,
  source: "workspace",
  draftKind: null,
  revision: "",
  truncated: false,
  loading: false,
  pending: false,
  loaded: false,
  error: "",
  snapshot: 0,
};

function fileRunning(file: ComputerFileClue | null): boolean {
  const status = String(file?.status || "running").trim().toLowerCase();
  return !["completed", "complete", "done", "failed", "error", "cancelled"].includes(status);
}

function responseStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const value = Number((error as { status?: unknown }).status);
  return Number.isFinite(value) ? value : 0;
}

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function lifecycleKey(file: ComputerFileClue | null): string {
  return String(
    file?.revision
    || [
      file?.tool_call_id || file?.tool || "file",
      file?.updated_sequence ?? file?.sequence ?? 0,
      file?.status || "running",
    ].join(":"),
  );
}

export function useComputerFilePreview(
  scope: AgentPreviewScope,
  file: ComputerFileClue | null,
) {
  const workspacePath = String(file?.workspace_path || "");
  const hostTarget = String(file?.target || "sandbox").toLowerCase() === "host";
  const running = fileRunning(file);
  const revision = lifecycleKey(file);
  const pathKey = `${scope.scope_type}\u0000${String(scope.scope_id)}\u0000${workspacePath}`;
  const [refreshToken, setRefreshToken] = useState(0);
  const [stored, setStored] = useState<{ pathKey: string; value: ComputerFilePreviewState }>({
    pathKey,
    value: {
      ...EMPTY_STATE,
      loading: !hostTarget && Boolean(workspacePath),
    },
  });

  useEffect(() => {
    if (hostTarget || !workspacePath) {
      setStored({ pathKey, value: EMPTY_STATE });
      return;
    }

    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setStored((current) => {
      const samePath = current.pathKey === pathKey;
      return {
        pathKey,
        value: samePath ? {
          ...current.value,
          loading: true,
          pending: false,
          error: "",
        } : {
          ...EMPTY_STATE,
          loading: true,
        },
      };
    });

    const request = async (attempt: number) => {
      if (stopped) return;
      controller = new AbortController();
      try {
        const result = await fetchPreviewFile(scope, workspacePath, controller.signal);
        if (stopped || controller.signal.aborted) return;
        setStored((current) => {
          if (current.pathKey !== pathKey) return current;
          const changed = !current.value.loaded || current.value.content !== result.content;
          return {
            pathKey,
            value: {
              ...current.value,
              content: result.content,
              previousContent: changed
                ? (current.value.loaded ? current.value.content : null)
                : current.value.previousContent,
              source: result.source,
              draftKind: result.source === "draft" ? result.draft_kind : null,
              revision: result.source === "draft" ? result.revision : "",
              truncated: result.truncated,
              loading: false,
              pending: false,
              loaded: true,
              error: "",
              snapshot: changed ? current.value.snapshot + 1 : current.value.snapshot,
            },
          };
        });
      } catch (error) {
        if (stopped || controller.signal.aborted || abortError(error)) return;
        const waitingForAtomicWrite = running && responseStatus(error) === 404;
        if (waitingForAtomicWrite && attempt < PENDING_RETRY_LIMIT) {
          setStored((current) => current.pathKey === pathKey ? {
            pathKey,
            value: {
              ...current.value,
              loading: true,
              pending: true,
              error: "",
            },
          } : current);
          retryTimer = setTimeout(() => void request(attempt + 1), PENDING_RETRY_DELAY_MS);
          return;
        }
        setStored((current) => {
          if (current.pathKey !== pathKey) return current;
          const discardTerminalDraft = !running && current.value.source === "draft";
          return {
            pathKey,
            value: {
              ...current.value,
              ...(discardTerminalDraft ? {
                content: "",
                previousContent: null,
                source: "workspace" as const,
                draftKind: null,
                revision: "",
                loaded: false,
              } : {}),
              loading: false,
              pending: waitingForAtomicWrite,
              error: waitingForAtomicWrite
                ? ""
                : error instanceof Error ? error.message : "",
            },
          };
        });
      }
    };

    void request(0);
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [
    hostTarget,
    pathKey,
    refreshToken,
    revision,
    running,
    scope.scope_id,
    scope.scope_type,
    workspacePath,
  ]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const state = stored.pathKey === pathKey
    ? stored.value
    : {
      ...EMPTY_STATE,
      loading: !hostTarget && Boolean(workspacePath),
    };
  return { state, refresh, hostTarget, workspacePath, running };
}
