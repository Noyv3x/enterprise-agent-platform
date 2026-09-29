import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPreviewFile } from "../../data/previewActions";
import { t } from "../../i18n";
import { getApiSessionGeneration } from "../../lib/api";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { AgentPreviewFileDraftKind, AgentPreviewFileSource, AgentPreviewScope, ComputerFileClue } from "../../types";

export interface ComputerFilePreviewState {
  content: string;
  previousContent: string | null;
  source: AgentPreviewFileSource;
  draftKind: AgentPreviewFileDraftKind | null;
  truncated: boolean;
  loading: boolean;
  loaded: boolean;
  error: string;
}

const EMPTY_STATE: ComputerFilePreviewState = {
  content: "", previousContent: null, source: "workspace", draftKind: null,
  truncated: false, loading: false, loaded: false, error: "",
};

export function useComputerFilePreview(scope: AgentPreviewScope, runId: string, file: ComputerFileClue | null) {
  const store = useStoreHandle();
  const account = useStore(value => `${getApiSessionGeneration()}:${value.user?.id ?? ""}`);
  const workspacePath = String(file?.workspace_path || "");
  const hostTarget = String(file?.target || "sandbox").toLowerCase() === "host";
  const running = file?.done !== true && !["completed", "complete", "done", "failed", "error", "cancelled"].includes(String(file?.status || "running").toLowerCase());
  const polling = running && file?.source === "draft";
  const [refreshToken, setRefreshToken] = useState(0);
  const identity = [account, scope.scope_type, scope.scope_id, runId, workspacePath, file?.tool, file?.tool_call_id, hostTarget, running, polling, refreshToken].join("\u0000");
  const desired = useRef({ identity, store });
  desired.current = { identity, store };
  const [stored, setStored] = useState({ identity: "", store, value: EMPTY_STATE });

  useEffect(() => {
    if (hostTarget || !workspacePath) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !controller.signal.aborted && desired.current.identity === identity && desired.current.store === store;
    setStored({ identity, store, value: { ...EMPTY_STATE, loading: true } });
    const load = async () => {
      try {
        const result = await fetchPreviewFile(scope, workspacePath, controller.signal);
        if (!current()) return;
        if (result.workspace_path !== workspacePath || (!running && result.source === "draft")) throw new Error(t("computer.file.failed"));
        setStored(previous => ({ identity, store, value: {
          content: result.content,
          previousContent: previous.identity === identity && previous.value.loaded ? previous.value.content : null,
          source: result.source, draftKind: result.source === "draft" ? result.draft_kind : null,
          truncated: result.truncated, loading: false, loaded: true, error: "",
        } }));
        // One latest-snapshot read at a time. Failures stop; there is no retry queue.
        if (polling) timer = setTimeout(() => { void load(); }, 300);
      } catch (error) {
        if (!current()) return;
        setStored({ identity, store, value: { ...EMPTY_STATE, error: error instanceof Error ? error.message : t("computer.file.failed") } });
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [identity, store, hostTarget, workspacePath, running, polling, scope.scope_type, scope.scope_id]);

  const refresh = useCallback(() => setRefreshToken(value => value + 1), []);
  const state = !hostTarget && workspacePath && stored.identity === identity && stored.store === store
    ? stored.value : { ...EMPTY_STATE, loading: !hostTarget && Boolean(workspacePath) };
  return { state, refresh, hostTarget, workspacePath, running };
}
