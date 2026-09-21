import { Button } from "../ui/beautiful"
import { useI18n } from "../../i18n";
import { formatFileSize } from "../../utils/format";
import { Icon } from "../common/Icon";
import { AttachmentSlot } from "../ui/beautiful"

export function ComposerFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useI18n();
  return <ul className="bui-draft-files">
    {files.map((file, index) => <li key={`${file.name}-${file.size}-${index}`}>
      <AttachmentSlot name={file.name || t("chat.attachment")} meta={formatFileSize(file.size)} actions={
        <Button variant="ghost" type="button" aria-label={t("chat.attach.removeAttachment")} title={t("chat.attach.remove")} icon={<Icon name="close" size={16} />} onClick={() => onRemove(index)} />
      } />
    </li>)}
  </ul>;
}
