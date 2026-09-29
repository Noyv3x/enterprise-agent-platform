import { Button } from "antd";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope, ComputerFileClue } from "../../types";
import { ComputerOutput, EmptyState, LoadingState, Notice } from "../ui/fieldwork";
import { useComputerFilePreview } from "./useComputerFilePreview";


function FileText({content, previous, streaming, running}: {content:string; previous:string|null; streaming:boolean; running:boolean}) {
  const lines = !streaming && content.length <= 24_000 ? content.replace(/\r\n?/g, "\n").split("\n") : [];
  const previousLines = previous?.replace(/\r\n?/g, "\n").split("\n") || [];
  const bounded = lines.length > 0 && lines.length <= 240;
  return <pre className="wf-file-text" aria-label="" data-render-mode={streaming ? "stream" : bounded ? "lines" : "plain"}><code>
    {bounded ? lines.map((line,index) => <span className="wf-file-line" key={index} data-changed={previous !== null && previousLines[index] !== line || undefined}>{line || "\u00a0"}</span>) : content}
    {running ? <span className="wf-file-caret" aria-hidden="true" /> : null}
  </code></pre>;
}

export function FileComputerView({scope,runId,file,compact=false}: {scope:AgentPreviewScope;runId:string;file:ComputerFileClue|null;compact?:boolean}) {
  const {t}=useI18n();
  const {state,refresh,hostTarget,workspacePath,running}=useComputerFilePreview(scope,runId,file);
  const streaming = state.loaded && running && state.source === "draft";
  const draftLabel=state.source === "draft" ? t(state.draftKind === "replacement" ? "computer.file.replacementDraft" : "computer.file.uncommittedDraft") : "";
  return <section className="wf-file-view" data-compact={compact || undefined} aria-busy={state.loading} data-source={state.loaded ? state.source : undefined} data-draft-kind={state.source === "draft" ? state.draftKind || undefined : undefined}>
    <ComputerOutput kind="file" title={file?.path || workspacePath || t("computer.mode.file")} meta={draftLabel || t("preview.readOnly")} truncated={state.truncated ? t("computer.file.truncated") : undefined}>
      {hostTarget ? <EmptyState compact title={t("computer.mode.file")} description={t("computer.file.host")} />
        : state.loaded ? <FileText content={state.content} previous={state.previousContent} streaming={streaming} running={running} />
        : state.loading ? <div aria-busy="true"><LoadingState label={t("computer.file.loading")} /></div>
        : state.error ? <Notice tone="danger" title={state.error} action={!compact ? <Button onClick={refresh}>{t("computer.retry")}</Button> : undefined} />
        : <EmptyState compact title={t("computer.mode.file")} description={t("computer.file.empty")} />}
    </ComputerOutput>
    {state.loaded && state.error ? <Notice tone="warning" title={state.error} action={!compact ? <Button onClick={refresh}>{t("computer.retry")}</Button> : undefined} /> : null}
  </section>;
}
