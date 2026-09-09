import { Button } from "antd";
import { useI18n } from "../../i18n";
import { formatFileSize } from "../../utils/format";
import { Icon } from "../common/Icon";
import { AttachmentSlot } from "../ui/fieldwork";

export function ComposerFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useI18n();
  return <ul className="wf-draft-files">
    {files.map((file, index) => <li key={`${file.name}-${file.size}-${index}`}>
      <AttachmentSlot name={file.name || t("chat.attachment")} meta={formatFileSize(file.size)} actions={
        <Button type="text" htmlType="button" aria-label={t("chat.attach.removeAttachment")} title={t("chat.attach.remove")} icon={<Icon name="close" size={16} />} onClick={() => onRemove(index)} />
      } />
    </li>)}
  </ul>;
}
