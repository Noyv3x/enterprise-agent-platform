import {Button,Popconfirm,Tooltip} from "antd";
import {useI18n} from "../../i18n";
import {Glyph} from "../ui/fieldwork";
export function WithdrawMessageButton({loading,onConfirm}:{loading:boolean;onConfirm:()=>Promise<void>|void}) {
 const {t}=useI18n();
 const label=t("chat.withdraw.action");
 return <Popconfirm title={t("chat.withdraw.confirmTitle")} description={t("chat.withdraw.confirmDescription")}
 okText={t("chat.withdraw.confirm")} cancelText={t("chat.confirm.cancel")} okButtonProps={{danger:true,loading}} onConfirm={onConfirm}>
 <Tooltip title={label}><Button type="text" size="small" className="wf-message-action" danger aria-label={label} disabled={loading} loading={loading} icon={<Glyph name="trash" size={16} />} /></Tooltip>
 </Popconfirm>;
}
