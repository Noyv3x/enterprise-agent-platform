import { useCallback, useEffect, useRef, useState } from "react";
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

interface PreviewRequestTarget {
  key: string;
  running: boolean;
  /** Identity of the running draft this read belongs to; see draftLineage(). */
  lineage: string;
}

interface PreviewRequestQueue {
  pathKey: string;
  enqueue: (target: PreviewRequestTarget) => void;
}

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

/** Everything but the draft revision: Run, scope, path, tool, tool call, target
 *  and the running/terminal phase. Two request keys with the same lineage differ
 *  only by the monotonic draft revision the SSE announced. The Run is part of
 *  the identity because a later Run may reuse a tool call id and restart the
 *  draft numbering for the same path. */
function draftLineage(
  runId: string,
  pathKey: string,
  file: ComputerFileClue | null,
  running: boolean,
  refreshToken: number,
): string {
  return [
    runId,
    pathKey,
    file?.tool || "",
    file?.tool_call_id || "",
    String(file?.target || "sandbox").toLowerCase(),
    running ? "running" : "terminal",
    refreshToken,
  ].join("\u0000");
}

/** Platform draft revisions are `draft:<tool_call_id>:<n>` with `n` increasing
 *  per tool call. A candidate is newer when it belongs to the same tool call
 *  and carries a larger `n`, or when nothing comparable is displayed yet. */
function newerDraftRevision(candidate: string, displayed: string): boolean {
  const candidateSplit = candidate.lastIndexOf(":");
  const candidateOrder = Number(candidate.slice(candidateSplit + 1));
  if (candidateSplit < 0 || !Number.isInteger(candidateOrder)) return false;
  const displayedSplit = displayed.lastIndexOf(":");
  if (displayedSplit < 0) return true;
  const displayedOrder = Number(displayed.slice(displayedSplit + 1));
  return displayed.slice(0, displayedSplit) !== candidate.slice(0, candidateSplit)
    || !Number.isInteger(displayedOrder)
    || candidateOrder > displayedOrder;
}

export function useComputerFilePreview(
  scope: AgentPreviewScope,
  runId: string,
  file: ComputerFileClue | null,
) {
  const workspacePath = String(file?.workspace_path || "");
  const hostTarget = String(file?.target || "sandbox").toLowerCase() === "host";
  const running = fileRunning(file);
  const revision = lifecycleKey(file);
  const pathKey = `${scope.scope_type}\u0000${String(scope.scope_id)}\u0000${workspacePath}`;
  const [refreshToken, setRefreshToken] = useState(0);
  const lineage = draftLineage(runId, pathKey, file, running, refreshToken);
  const requestKey = `${lineage}\u0000${revision}`;
  const desiredRequestKeyRef = useRef(requestKey);
  desiredRequestKeyRef.current = requestKey;
  const desiredLineageRef = useRef(lineage);
  desiredLineageRef.current = lineage;
  const requestQueueRef = useRef<PreviewRequestQueue | null>(null);
  const [stored, setStored] = useState<{ pathKey: string; lineage: string; value: ComputerFilePreviewState }>({
    pathKey,
    lineage: "",
    value: {
      ...EMPTY_STATE,
      loading: !hostTarget && Boolean(workspacePath),
    },
  });

  useEffect(() => {
    if (hostTarget || !workspacePath) {
      requestQueueRef.current = null;
      setStored({ pathKey, lineage: "", value: EMPTY_STATE });
      return;
    }

    let stopped = false;
    let inFlight = false;
    let pumpScheduled = false;
    let pending: PreviewRequestTarget | null = null;
    let latestRequestKey = "";
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const requestScope: AgentPreviewScope = {
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
    };

    setStored((current) => {
      const samePath = current.pathKey === pathKey;
      return {
        pathKey,
        lineage: samePath ? current.lineage : "",
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

    const markLoading = () => {
      setStored((current) => current.pathKey === pathKey ? {
        pathKey,
        lineage: current.lineage,
        value: {
          ...current.value,
          loading: true,
          pending: false,
          error: "",
        },
      } : current);
    };

    let pump: () => void;

    const schedulePump = () => {
      if (stopped || pumpScheduled) return;
      pumpScheduled = true;
      queueMicrotask(() => {
        pumpScheduled = false;
        pump();
      });
    };

    const finishRequest = () => {
      controller = null;
      inFlight = false;
      pump();
    };

    const request = async (target: PreviewRequestTarget, attempt: number) => {
      if (stopped) return;
      const requestController = new AbortController();
      controller = requestController;
      try {
        const result = await fetchPreviewFile(requestScope, workspacePath, requestController.signal);
        if (stopped || requestController.signal.aborted) return;
        const desired = pending === null && desiredRequestKeyRef.current === target.key;
        const draftRevision = result.source === "draft" ? result.revision : "";
        // A newer lifecycle revision arrived while this read was in flight. For a
        // running draft the endpoint returns its own monotonic draft revision, so
        // a response that still belongs to the same draft lineage is real,
        // provable progress: reveal it now and keep chasing the newest queued
        // revision instead of discarding every answer while the stream is fast.
        // Any other supersession (scope, path, tool call, target, terminal
        // transition, manual refresh) cannot prove what it represents: skip it.
        const progress = !desired
          && draftRevision !== ""
          && desiredLineageRef.current === target.lineage;
        if (desired || progress) {
          setStored((current) => {
            if (current.pathKey !== pathKey) return current;
            if (progress && current.lineage === target.lineage
              && !newerDraftRevision(draftRevision, current.value.revision)) {
              return current;
            }
            const changed = !current.value.loaded || current.value.content !== result.content;
            return {
              pathKey,
              lineage: target.lineage,
              value: {
                ...current.value,
                content: result.content,
                previousContent: current.value.loaded ? current.value.content : null,
                source: result.source,
                draftKind: result.source === "draft" ? result.draft_kind : null,
                revision: draftRevision,
                truncated: result.truncated,
                loading: !desired,
                pending: false,
                loaded: true,
                error: "",
                snapshot: changed ? current.value.snapshot + 1 : current.value.snapshot,
              },
            };
          });
        }
        finishRequest();
      } catch (error) {
        if (stopped || requestController.signal.aborted || abortError(error)) return;
        if (pending !== null || desiredRequestKeyRef.current !== target.key) {
          finishRequest();
          return;
        }
        const waitingForAtomicWrite = target.running && responseStatus(error) === 404;
        if (waitingForAtomicWrite && attempt < PENDING_RETRY_LIMIT) {
          setStored((current) => current.pathKey === pathKey ? {
            pathKey,
            lineage: current.lineage,
            value: {
              ...current.value,
              loading: true,
              pending: true,
              error: "",
            },
          } : current);
          controller = null;
          inFlight = false;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (stopped) return;
            if (pending !== null) {
              pump();
              return;
            }
            inFlight = true;
            void request(target, attempt + 1);
          }, PENDING_RETRY_DELAY_MS);
          return;
        }
        setStored((current) => {
          if (current.pathKey !== pathKey) return current;
          const discardTerminalDraft = !target.running && current.value.source === "draft";
          return {
            pathKey,
            lineage: current.lineage,
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
        finishRequest();
      }
    };

    pump = () => {
      if (stopped || inFlight || pending === null) return;
      const target = pending;
      pending = null;
      inFlight = true;
      void request(target, 0);
    };

    const queue: PreviewRequestQueue = {
      pathKey,
      enqueue: (target) => {
        if (stopped || latestRequestKey === target.key) return;
        latestRequestKey = target.key;
        pending = target;
        markLoading();
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        schedulePump();
      },
    };
    requestQueueRef.current = queue;
    return () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      controller?.abort();
      if (requestQueueRef.current === queue) requestQueueRef.current = null;
    };
  }, [
    hostTarget,
    pathKey,
    scope.scope_id,
    scope.scope_type,
    workspacePath,
  ]);

  useEffect(() => {
    if (hostTarget || !workspacePath) return;
    const queue = requestQueueRef.current;
    if (!queue || queue.pathKey !== pathKey) return;
    queue.enqueue({
      key: requestKey,
      running,
      lineage,
    });
  }, [hostTarget, lineage, pathKey, requestKey, running, workspacePath]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const state = stored.pathKey === pathKey
    ? stored.value
    : {
      ...EMPTY_STATE,
      loading: !hostTarget && Boolean(workspacePath),
    };
  return { state, refresh, hostTarget, workspacePath, running };
}
