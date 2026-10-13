import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { request, type ArtifactPreview, type ArtifactView, type ArtifactVersion } from "../../api";
import type { Attachment } from "../conversation/types";
import { errorText } from "../conversation/useConversation";

/** The artifact version the panel shows. `follow` (viewing the latest) moves it to each new version; null until the
 * latest is known (a card opened before the artifact loaded). */
export interface ArtifactSelection { id: number; version: number; follow: boolean | null }

/** The panel's note about the open artifact: it moved to a new version, or a newer one exists. */
export interface VersionNotice { type: "updated" | "newer"; version: number; seq: number }

/** `GET /api/artifacts/{id}`; `round` is the refresh round it was fetched in, `previewSeq` the stream's newest preview
 * seq for it when it was requested (a later streamed state wins over it). */
interface Detail { artifact: ArtifactView; versions: ArtifactVersion[]; preview?: ArtifactPreview; round: number; previewSeq: number }

/** The 作品 panel's data and actions (useArtifacts). */
export interface ArtifactsState {
  /** the conversation's artifacts, newest update first; null while the first list loads */
  list: ArtifactView[] | null;
  listError: string;
  reloadList: () => Promise<void>;
  selection: ArtifactSelection | null;
  /** the selected artifact at its newest known state */
  artifact: ArtifactView | null;
  /** the selected artifact's versions, newest first (empty until they load) */
  versions: ArtifactVersion[];
  detailLoaded: boolean;
  detailError: string;
  notice: VersionNotice | null;
  /** selects an artifact at a version (a card, or the list at the latest) */
  open: (id: number, version: number) => void;
  chooseVersion: (version: number) => void;
  /** back to the list */
  back: () => void;
  reloadDetail: () => void;
  /** a live artifact's preview, the newest of the detail and the stream; null until known */
  previewOf: (id: number) => ArtifactPreview | null;
  /** fetches the open artifact again (a live preview after 停止服务) */
  refreshDetail: () => void;
  /** the attachment the panel shows in file mode, over the artifact or list beneath it */
  file: Attachment | null;
  openFile: (file: Attachment) => void;
  /** leaves file mode, back to what was open beneath */
  closeFile: () => void;
}

/** How long "已更新到 vN" stays in the toolbar. */
const UPDATED_MS = 4000;

/** The conversation's artifacts and the 作品 panel's selection: the list (fetched once the panel shows, or at once when
 * the transcript has live preview cards whose state it carries; kept current by SSE `artifact`), the open artifact's
 * versions, following new versions, and revealing a new artifact on desktop. */
export function useArtifacts({ scope, published, lastPublished, previews, shown, liveCards = false, narrow, reveal }: {
  scope: string;
  /** artifacts as the stream announced them */
  published: Record<number, ArtifactView>;
  lastPublished: { id: number; version: number; seq: number } | null;
  /** live previews' states as the stream announced them */
  previews: Record<number, { preview: ArtifactPreview; seq: number }>;
  /** the 作品 panel is on screen */
  shown: boolean;
  /** the transcript shows live preview cards */
  liveCards?: boolean;
  narrow: boolean;
  /** shows the 作品 panel (a publish on desktop) */
  reveal: () => void;
}): ArtifactsState {
  const [loaded, setLoaded] = useState<ArtifactView[] | null>(null);
  const [listError, setListError] = useState("");
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [detailError, setDetailError] = useState<{ id: number; text: string } | null>(null);
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const [notice, setNotice] = useState<VersionNotice | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [file, setFile] = useState<Attachment | null>(null);
  const [round, setRound] = useState(0);
  const streamed = useRef(previews);
  streamed.current = previews;

  const loadList = useCallback(async () => {
    setListError("");
    try {
      setLoaded((await request<{ artifacts: ArtifactView[] }>(`/api/artifacts?scope=${encodeURIComponent(scope)}`)).artifacts);
    } catch (error) {
      setListError(errorText(error));
    }
  }, [scope]);
  const listRequested = useRef(false);
  useEffect(() => {
    if ((!shown && !liveCards) || listRequested.current) return;
    listRequested.current = true;
    void loadList();
  }, [shown, liveCards, loadList]);

  /** Every known artifact at its newest known state, newest update first. */
  const artifacts = useMemo(() => {
    const byId = new Map<number, ArtifactView>();
    const take = (artifact: ArtifactView) => {
      const known = byId.get(artifact.id);
      // A live preview stays at version 0: its newest update wins.
      if (!known || known.latest_version < artifact.latest_version || (known.latest_version === artifact.latest_version && known.updated_at < artifact.updated_at)) {
        byId.set(artifact.id, artifact);
      }
    };
    for (const artifact of loaded ?? []) take(artifact);
    for (const detail of Object.values(details)) take(detail.artifact);
    for (const artifact of Object.values(published)) take(artifact);
    return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
  }, [loaded, details, published]);
  const list = loaded === null && !Object.keys(published).length ? null : artifacts;

  const selectedId = selection?.id ?? null;
  const artifact = selectedId === null ? null : artifacts.find((item) => item.id === selectedId) ?? null;
  const detail = selectedId === null ? undefined : details[selectedId];
  const latest = artifact?.latest_version ?? 0;
  const knownTop = detail?.versions.reduce((top, item) => Math.max(top, item.version), 0) ?? 0;

  // The open artifact's versions: fetched on open, once more when a newer version than the listed ones arrives, and on
  // refreshDetail.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (selectedId === null || (detail && knownTop >= latest && detail.round >= round)) return;
    const key = `${selectedId}:${latest}:${attempt}:${round}`;
    if (attempted.current.has(key)) return;
    attempted.current.add(key);
    const previewSeq = streamed.current[selectedId]?.seq ?? 0;
    request<Omit<Detail, "round" | "previewSeq">>(`/api/artifacts/${selectedId}`).then(
      (result) => {
        setDetails((current) => ({ ...current, [selectedId]: { ...result, round, previewSeq } }));
        setDetailError(null);
      },
      (error: unknown) => setDetailError({ id: selectedId, text: errorText(error) }),
    );
  }, [selectedId, detail, knownTop, latest, attempt, round]);

  /** Newest first; a version the stream announced before the list was refetched shows at once. */
  const versions = useMemo(() => {
    const listed = detail?.versions ?? [];
    if (!artifact || listed.some((item) => item.version === artifact.latest_version) || !listed.length) return [...listed].sort((a, b) => b.version - a.version);
    return [
      { version: artifact.latest_version, entry: artifact.entry ?? "", created_at: artifact.updated_at, total_size: 0, file_count: 0, message_id: null },
      ...listed,
    ].sort((a, b) => b.version - a.version);
  }, [detail, artifact]);

  // A card opened before its artifact was known decides whether it views the latest once that is known.
  useEffect(() => {
    if (selection?.follow !== null || !selection || !detail) return;
    setSelection({ ...selection, follow: selection.version >= latest });
  }, [selection, detail, latest]);

  // Follow the open artifact's new versions, or say a newer one exists; reveal a new artifact on desktop.
  const revealed = useRef(new Set<number>());
  const handled = useRef(0);
  const state = useRef({ selection, shown, narrow, reveal, file });
  state.current = { selection, shown, narrow, reveal, file };
  useEffect(() => {
    if (!lastPublished || lastPublished.seq <= handled.current) return;
    handled.current = lastPublished.seq;
    const { selection: current, shown: visible, narrow: phone, reveal: show, file: showing } = state.current;
    const { id, version, seq } = lastPublished;
    if (current?.id === id) {
      if (current.version >= version) return;
      if (current.follow !== false) {
        setSelection({ id, version, follow: true });
        setNotice({ type: "updated", version, seq });
      } else {
        setNotice({ type: "newer", version, seq });
      }
      return;
    }
    // Another artifact or a file stays in view; a new one takes an empty panel, or opens it on desktop once.
    if (visible && (current || showing)) return;
    if (visible || (!phone && !revealed.current.has(id))) {
      revealed.current.add(id);
      setSelection({ id, version, follow: true });
      setNotice(null);
      setFile(null);
      if (!visible) show();
    }
  }, [lastPublished]);

  useEffect(() => {
    if (notice?.type !== "updated") return;
    const timer = window.setTimeout(() => setNotice((current) => (current === notice ? null : current)), UPDATED_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const open = useCallback((id: number, version: number) => {
    const known = artifacts.find((item) => item.id === id);
    revealed.current.add(id);
    setSelection({ id, version, follow: known && details[id] ? version >= known.latest_version : null });
    setNotice(null);
    setFile(null);
  }, [artifacts, details]);

  const chooseVersion = useCallback((version: number) => {
    setSelection((current) => (current ? { ...current, version, follow: version >= latest } : current));
    setNotice((current) => (current?.type === "newer" && version >= current.version ? null : current));
  }, [latest]);

  const back = useCallback(() => {
    setSelection(null);
    setNotice(null);
  }, []);

  const openFile = useCallback((next: Attachment) => setFile(next), []);
  const closeFile = useCallback(() => setFile(null), []);

  const reloadDetail = useCallback(() => {
    setDetailError(null);
    setAttempt((value) => value + 1);
  }, []);

  const refreshDetail = useCallback(() => setRound((value) => value + 1), []);

  /** The stream's state when it is newer than the fetched detail, else the detail's, else the list's. */
  const previewOf = useCallback((id: number) => {
    const stream = previews[id];
    const fetched = details[id];
    if (stream && (!fetched?.preview || stream.seq > fetched.previewSeq)) return stream.preview;
    return fetched?.preview ?? loaded?.find((item) => item.id === id)?.preview ?? null;
  }, [previews, details, loaded]);

  return {
    list, listError, reloadList: loadList,
    selection, artifact, versions, detailLoaded: Boolean(detail),
    detailError: detailError && detailError.id === selectedId ? detailError.text : "",
    notice, open, chooseVersion, back, reloadDetail, previewOf, refreshDetail, file, openFile, closeFile,
  };
}
