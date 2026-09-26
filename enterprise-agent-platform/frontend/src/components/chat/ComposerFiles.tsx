import { useI18n } from "../../i18n";
import { formatFileSize } from "../../utils/format";
import { BUI_PATHS, BuiIcon } from "../ui/beautiful";

/** Beautiful UI Prompt Bar attachment chips: file glyph, name, size, and a remove control. */
export function ComposerFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useI18n();
  return <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
    {files.map((file, index) => {
      const name = file.name || t("chat.attachment");
      return <li key={`${file.name}-${file.size}-${index}`} className="flex h-6.5 max-w-full min-w-0 items-center gap-1.5 rounded-chip bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline"
        style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <BuiIcon size={12}>{BUI_PATHS.file}</BuiIcon>
        <span className="max-w-48 min-w-0 truncate" title={name}>{name}</span>
        <span className="shrink-0 text-ink-3 tabular-nums">{formatFileSize(file.size)}</span>
        <button type="button" aria-label={t("chat.attach.removeAttachment")} title={t("chat.attach.remove")} onClick={() => onRemove(index)}
          className="-my-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-line hover:text-ink">
          <BuiIcon size={10} strokeWidth={2.5}>{BUI_PATHS.close}</BuiIcon>
        </button>
      </li>;
    })}
  </ul>;
}
