import { Button, Popconfirm } from "antd";
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";

export function WithdrawMessageButton({
  loading,
  onConfirm,
}: {
  loading: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  return (
    <Popconfirm
      title={t("chat.withdraw.confirmTitle")}
      description={t("chat.withdraw.confirmDescription")}
      okText={t("chat.withdraw.confirm")}
      cancelText={t("chat.confirm.cancel")}
      okButtonProps={{ danger: true, loading }}
      onConfirm={onConfirm}
    >
      <Button
        type="text"
        size="small"
        danger
        className="chat-withdraw"
        aria-label={t("chat.withdraw.action")}
        loading={loading}
        disabled={loading}
        icon={loading ? undefined : <Icon name="trash" size={14} />}
      >
        <span className="chat-withdraw__label">{t("chat.withdraw.action")}</span>
      </Button>
    </Popconfirm>
  );
}
