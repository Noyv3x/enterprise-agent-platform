import {Button,Popconfirm} from "antd";
import {useI18n} from "../../i18n";
export function WithdrawMessageButton({loading,onConfirm}:{loading:boolean;onConfirm:()=>Promise<void>|void}) {
 const {t}=useI18n();
 return <Popconfirm title={t("chat.withdraw.confirmTitle")} description={t("chat.withdraw.confirmDescription")}
 okText={t("chat.withdraw.confirm")} cancelText={t("chat.confirm.cancel")} okButtonProps={{danger:true,loading}} onConfirm={onConfirm}>
 <Button type="text" danger disabled={loading} loading={loading}>{t("chat.withdraw.action")}</Button>
 </Popconfirm>;
}
