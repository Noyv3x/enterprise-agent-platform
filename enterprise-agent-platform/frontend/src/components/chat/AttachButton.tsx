import { Button } from "../ui/beautiful"
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";

export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return <Button variant="ghost" type="button" disabled={disabled} onClick={onClick} icon={<Icon name="paperclip" size={18} />}>
    {t("chat.attach.add")}
  </Button>;
}
