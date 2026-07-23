/* <ComposerFiles/> — the row of selected-but-unsent attachment chips with remove
   buttons (legacy renderComposerFiles, :1201-1223). `files` are raw File objects
   from the per-scope draftFiles store entry. */

import { formatFileSize } from "../../utils/format";
import { useI18n } from "../../i18n";
import { Button, Tooltip } from "antd";
import { Icon } from "../common/Icon";

export function ComposerFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (index: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="composer-files">
      {files.map((file, index) => (
        <div className="composer-file" key={`${file.name}-${file.size}-${index}`}>
          <span className="composer-file__icon">
            <Icon name={file.type?.startsWith("image/") ? "image" : "doc"} size={15} />
          </span>
          <span className="composer-file__name">{file.name || t("chat.attachment")}</span>
          <span className="composer-file__size">{formatFileSize(file.size || 0)}</span>
          <Tooltip title={t("chat.attach.remove")}>
            <Button
              className="composer-file__remove"
              type="text"
              shape="circle"
              size="small"
              aria-label={t("chat.attach.removeAttachment")}
              icon={<Icon name="close" size={14} />}
              onClick={() => onRemove(index)}
            />
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
