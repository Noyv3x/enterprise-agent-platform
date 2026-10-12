/** Artifact (作品) shapes shared by the panel, the cards and the renderers (platform-api.md § Artifacts). */
import type { ArtifactKind, ArtifactSource, ArtifactView } from "../../api";

export type { ArtifactFile, ArtifactKind, ArtifactSource, ArtifactVersion, ArtifactView } from "../../api";

/** What every preview renderer receives. The panel re-mounts a renderer (by key) on 刷新 or a version switch. */
export interface ArtifactRendererProps {
  artifact: ArtifactView;
  version: number;
  /** the entry relpath of this version */
  entry: string;
  /** a fresh `/artifact-view/<token>/<entry>` for this version; null while it is minted */
  viewUrl: string | null;
  /** text of a file of this version (default: the entry), cached per version */
  loadSource: (path?: string) => Promise<ArtifactSource>;
}

/** Kinds whose single entry file is text: they get 对比上一版. */
export const TEXT_KINDS: Partial<Record<ArtifactKind, true>> = { web: true, markdown: true, mermaid: true, svg: true, table: true, code: true };
