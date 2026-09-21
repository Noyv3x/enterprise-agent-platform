import { Button, Tooltip } from "antd";
import { useI18n } from "../../i18n";
import { Glyph } from "../ui/fieldwork";

export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const label = t("chat.attach.add");
  return <Tooltip title={label}><Button className="wf-composer-attach" type="text" shape="circle" htmlType="button" disabled={disabled} onClick={onClick} aria-label={label} icon={<Glyph name="attach" size={18} />} /></Tooltip>;
}
