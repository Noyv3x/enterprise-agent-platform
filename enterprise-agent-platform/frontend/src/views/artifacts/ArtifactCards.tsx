import { createContext, useContext } from "react";
import { Icon } from "../../components/ui/beautiful/controls";
import { useWords } from "../../words";
import type { Attachment, Message } from "../conversation/types";
import { KindIcon, kindLabel, previewLabel } from "./kinds";
import { ICON_BUTTON } from "./toolbar";
import type { ArtifactKind, ArtifactPreview, ArtifactRef } from "../../api";

/** Opens the 作品 panel at one artifact version, or an attachment in its file mode; provided by the conversation. */
export interface ArtifactOpener {
  open: (id: number, version: number) => void;
  /** the artifact version the panel shows, so its card reads as open */
  current: { id: number; version: number } | null;
  /** a live artifact's preview state, for its card */
  previewOf?: (id: number) => ArtifactPreview | null;
  openFile: (file: Attachment) => void;
  /** the attachment the panel shows, so its card reads as open */
  currentFile: number | null;
}

export const ArtifactsContext = createContext<ArtifactOpener | null>(null);

const KINDS: Record<ArtifactKind, true> = {
  web: true, site: true, markdown: true, mermaid: true, svg: true, table: true, code: true, image: true, pdf: true, docx: true, xlsx: true, pptx: true, live: true,
};

/** The artifact versions an assistant message's run published (`metadata.artifacts`), one per artifact at its newest
 * version; malformed entries are skipped. */
export function messageArtifacts(message: Message): ArtifactRef[] {
  const raw: unknown = message.metadata.artifacts;
  if (!Array.isArray(raw)) return [];
  const byId = new Map<number, ArtifactRef>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, version, title, kind, path } = entry as Record<string, unknown>;
    if (typeof id !== "number" || typeof version !== "number" || typeof kind !== "string" || !KINDS[kind as ArtifactKind]) continue;
    const ref: ArtifactRef = { id, version, kind: kind as ArtifactKind, title: typeof title === "string" ? title : "", path: typeof path === "string" ? path : "" };
    const known = byId.get(id);
    if (!known || known.version < version) byId.set(id, ref);
  }
  return [...byId.values()];
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** A published artifact in a reply: kind icon, title, "v3 · 网页" (a live preview: "网站预览 · 运行中") and 打开, which
 * opens the panel at that version, and 下载 for that version (a live preview has no files). */
export function ArtifactCards({ artifacts }: { artifacts: ArtifactRef[] }) {
  const w = useWords();
  const opener = useContext(ArtifactsContext);
  return (
    <div className="flex w-full max-w-95 flex-col gap-2">
      {artifacts.map((artifact, index) => {
        const title = artifact.title || baseName(artifact.path);
        const meta = artifact.kind === "live"
          ? [kindLabel("live", w), previewLabel(opener?.previewOf?.(artifact.id), w)].filter(Boolean).join(" · ")
          : `v${artifact.version} · ${kindLabel(artifact.kind, w)}`;
        const open = opener?.current?.id === artifact.id && opener.current.version === artifact.version;
        return (
          <div
            key={artifact.id}
            className={`flex w-full items-center rounded-card bg-surface shadow-card transition-[box-shadow,background-color] duration-150 has-[>button:enabled:hover]:bg-inset ${
              open ? "ring-1 ring-accent" : ""
            }`}
            style={{ animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${index * 100}ms both` }}
          >
            <button
              type="button"
              disabled={!opener}
              aria-label={w(`Open ${title}, ${meta}`, `打开 ${title}，${meta}`, `開啟 ${title}，${meta}`)}
              aria-current={open || undefined}
              onClick={() => opener?.open(artifact.id, artifact.version)}
              className={`group flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-card p-2.5 text-left disabled:opacity-60 ${artifact.kind === "live" ? "pr-3" : "pr-1"}`}
            >
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-ink shadow-hairline">
                <KindIcon kind={artifact.kind} size={17} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium text-ink" title={title}>{title}</span>
                <span className="truncate text-[12px] text-ink-2 tabular-nums">{meta}</span>
              </span>
              <span aria-hidden className="inline-flex h-7 shrink-0 items-center rounded-full bg-inset px-3 text-[12px] font-medium text-ink shadow-btn transition-colors duration-150 group-hover:bg-surface touch:h-11 touch:px-4">
                {open ? w("Showing", "已打开", "已開啟") : w("Open", "打开", "開啟")}
              </span>
            </button>
            {artifact.kind !== "live" && (
              <a
                href={`/api/artifacts/${artifact.id}/versions/${artifact.version}/download`}
                download
                aria-label={w(`Download ${title}, v${artifact.version}`, `下载 ${title}，v${artifact.version}`, `下載 ${title}，v${artifact.version}`)}
                title={w("Download", "下载", "下載")}
                className={`${ICON_BUTTON} mr-2`}
              >
                <Icon name="download" size={14} />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
