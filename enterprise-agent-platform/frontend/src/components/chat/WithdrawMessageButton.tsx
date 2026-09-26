import {Popconfirm,Tooltip} from "antd";
import {useI18n} from "../../i18n";
import {BUI_PATHS,BuiIcon} from "../ui/beautiful";
import {MESSAGE_ACTION} from "./messageAction";
export function WithdrawMessageButton({loading,onConfirm}:{loading:boolean;onConfirm:()=>Promise<void>|void}) {
 const {t}=useI18n();
 const label=t("chat.withdraw.action");
 return <Popconfirm title={t("chat.withdraw.confirmTitle")} description={t("chat.withdraw.confirmDescription")}
 okText={t("chat.withdraw.confirm")} cancelText={t("chat.confirm.cancel")} okButtonProps={{danger:true,loading}} onConfirm={onConfirm}>
 <Tooltip title={label}><button type="button" className={`${MESSAGE_ACTION} hover:text-red`} aria-label={label} disabled={loading} aria-busy={loading||undefined}>
  {loading?<span aria-hidden="true" className="size-3 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{animation:"spin 700ms linear infinite"}}/>:<BuiIcon size={15}>{BUI_PATHS.undo}</BuiIcon>}
 </button></Tooltip>
 </Popconfirm>;
}
