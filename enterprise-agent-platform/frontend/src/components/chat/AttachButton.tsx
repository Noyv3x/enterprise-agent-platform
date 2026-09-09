import { Button } from "antd";
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";

export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return <Button type="text" htmlType="button" disabled={disabled} onClick={onClick} icon={<Icon name="paperclip" size={18} />}>
    {t("chat.attach.add")}
  </Button>;
}
