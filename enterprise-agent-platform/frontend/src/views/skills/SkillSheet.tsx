import { useEffect, useState, type ReactNode } from "react";
import { request, type SkillDetail, type SkillView } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { DescriptionList, Notice, Sheet } from "../../components/ui/beautiful/controls";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { RecordTag } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";
import { formatTime } from "../admin/shared";
import { formatBytes } from "../conversation/Attachments";
import { Markdown } from "../conversation/Markdown";
import { skillBody, skillPath, useSkillLabels } from "./skills";

/** Files listed before the rest is summarized; a package may hold up to 2000. */
const FILE_LIMIT = 200;

/** One skill: source, version, warnings, SKILL.md rendered as Markdown and the package's files. `children` (the
 * administrator's assignment form) sits above the content; `footer` holds the row's actions. */
export function SkillSheet({ skill, onClose, footer, children }: {
  skill: SkillView;
  onClose: () => void;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const w = useWords();
  const labels = useSkillLabels();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // The list row may be newer than the loaded detail (a toggle or an update while the sheet is open).
  const updated = skill.updated_at;
  useEffect(() => {
    let current = true;
    setError("");
    request<SkillDetail>(skillPath(skill.key))
      .then((next) => { if (current) setDetail(next); })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [skill.key, updated, attempt]);

  const url = skill.source?.url;
  const heading = "text-[12.5px] font-medium text-ink-2";
  const files = detail?.files ?? [];
  return (
    <Sheet open onClose={onClose} width={560} title={skill.name} description={skill.description} footer={footer}>
      <div data-autofocus tabIndex={-1} className="flex flex-col gap-5" style={{ outline: "none" }}>
        <DescriptionList items={[
          { key: "source", label: w("Source", "来源", "來源"), value: <span className="flex min-w-0 items-center gap-2"><RecordTag tag={labels.tag(skill)} />{skill.tier === "org" && labels.source(skill) && <RecordTag tag={labels.source(skill)!} />}</span> },
          { key: "version", label: w("Version", "版本", "版本"), value: labels.version(skill) ? <span className="font-mono text-[12.5px]">{labels.version(skill)}</span> : w("Not stated", "未标注", "未標註") },
          ...(url ? [{ key: "url", label: w("Link", "链接", "連結"), value: <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="font-mono text-[12.5px] text-accent-ink underline-offset-2 hover:underline">{url}</a> }] : []),
          { key: "updated", label: w("Updated", "更新时间", "更新時間"), value: <span className="font-mono text-[12.5px] tabular-nums">{formatTime(skill.updated_at)}</span> },
        ]} />
        {skill.warnings.length > 0 && (
          <Notice tone="warning" title={labels.warnings(skill.warnings.length)}>
            <ul className="flex list-disc flex-col gap-0.5 pl-4">{skill.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </Notice>
        )}
        {children}
        <section className="flex flex-col gap-1.5">
          <h3 className={heading}>SKILL.md</h3>
          {error && !detail ? (
            <Notice tone="danger" title={w("The skill could not be loaded", "无法加载技能内容", "無法載入技能內容")}
              action={<Button size="sm" className="touch:h-11" onClick={() => setAttempt((value) => value + 1)}>{w("Retry", "重试", "重試")}</Button>}>
              {error}
            </Notice>
          ) : !detail ? (
            <LoadingState variant="Dots" label={w("Loading the skill", "正在加载技能内容", "正在載入技能內容")} className="py-1" />
          ) : (
            <div className="bui-prose min-w-0 rounded-card bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink shadow-card"><Markdown content={skillBody(detail.content)} /></div>
          )}
        </section>
        {detail && (
          <section className="flex flex-col gap-1.5">
            <h3 className={heading}>{w(`Files (${files.length})`, `文件（${files.length}）`, `檔案（${files.length}）`)}</h3>
            <ul className="flex flex-col rounded-card bg-surface shadow-card" aria-label={w("Files", "文件", "檔案")}>
              {files.slice(0, FILE_LIMIT).map((file) => (
                <li key={file.path} className="flex min-h-8 items-center gap-3 border-b border-line px-3 py-1 last:border-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={file.path}>{file.path}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-2 tabular-nums">{formatBytes(file.size_bytes)}</span>
                </li>
              ))}
              {files.length > FILE_LIMIT && (
                <li className="px-3 py-1.5 text-[12px] text-ink-2">{w(`${files.length - FILE_LIMIT} more files`, `另有 ${files.length - FILE_LIMIT} 个文件`, `另有 ${files.length - FILE_LIMIT} 個檔案`)}</li>
              )}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  );
}
