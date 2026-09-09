import { Button } from "antd";
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";

export function SendButton({ disabled, loading = false }: { disabled: boolean; loading?: boolean }) {
  const { t } = useI18n();
  return <Button className="wf-composer-send" type="primary" htmlType="submit" disabled={disabled} loading={loading} title={t("chat.composer.sendTitle")} icon={<Icon name="send" size={18} />}>
    {t("chat.composer.send")}
  </Button>;
}
