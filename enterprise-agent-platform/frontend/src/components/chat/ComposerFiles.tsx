/* <ComposerFiles/> — the row of selected-but-unsent attachment chips with remove
   buttons (legacy renderComposerFiles, :1201-1223). `files` are raw File objects
   from the per-scope draftFiles store entry. */

import { formatFileSize } from "../../utils/format";
import { Icon } from "../common/Icon";

export function ComposerFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (index: number) => void;
}) {
  return (
    <div className="composer-files">
      {files.map((file, index) => (
        <div className="composer-file" key={`${file.name}-${file.size}-${index}`}>
          <span className="composer-file__icon">
            <Icon name={file.type?.startsWith("image/") ? "image" : "doc"} size={15} />
          </span>
          <span className="composer-file__name">{file.name || "attachment"}</span>
          <span className="composer-file__size">{formatFileSize(file.size || 0)}</span>
          <button
            className="icon-btn composer-file__remove"
            type="button"
            title="移除"
            aria-label="移除附件"
            onClick={() => onRemove(index)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
