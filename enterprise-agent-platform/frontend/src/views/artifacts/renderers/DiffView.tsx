/** 对比上一版: the entry text of two versions as a unified line diff in the CodeBlock Diff variant. */
import { EmptyState } from "../../../components/ui/beautiful/controls";
import CodeBlock from "../../../components/ui/beautiful/primitives/CodeBlock";
import { useWords } from "../../../words";
import type { ArtifactSource, ArtifactView } from "../types";
import { unifiedDiff } from "./lineDiff";
import { RendererFailed, RendererLoading, TruncatedNote, useCodeLabels, useLoaded } from "./states";

export function ArtifactDiff({ artifact, version, previousVersion, loadSource, loadPreviousSource }: {
  artifact: ArtifactView;
  version: number;
  previousVersion: number;
  /** each defaults to its own version's entry */
  loadSource: (path?: string) => Promise<ArtifactSource>;
  loadPreviousSource: (path?: string) => Promise<ArtifactSource>;
}) {
  const w = useWords();
  const labels = useCodeLabels();
  const loaded = useLoaded(
    () => Promise.all([loadPreviousSource(), loadSource()]).then(([before, after]) => ({
      diff: unifiedDiff(before.content, after.content),
      truncated: before.truncated || after.truncated,
    })),
    `${artifact.id}:${previousVersion}:${version}`,
  );
  if (loaded.status === "loading") return <RendererLoading />;
  if (loaded.status === "failed") return <RendererFailed error={loaded.error} retry={loaded.retry} />;
  const { diff, truncated } = loaded.value;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {truncated && <TruncatedNote className="shrink-0" />}
      {diff === null ? (
        <EmptyState
          icon="check"
          className="min-h-0 flex-1"
          title={w(`v${previousVersion} and v${version} are the same`, `v${previousVersion} 与 v${version} 内容相同`, `v${previousVersion} 與 v${version} 內容相同`)}
          description={w("No line changed between these versions.", "两个版本之间没有任何行发生变化。", "兩個版本之間沒有任何行發生變化。")}
        />
      ) : (
        <div className="min-h-0 flex-1">
          <CodeBlock fill fillHeight variant="Diff" code={diff} filename={`${artifact.entry} · v${previousVersion} → v${version}`} labels={labels} />
        </div>
      )}
    </div>
  );
}
