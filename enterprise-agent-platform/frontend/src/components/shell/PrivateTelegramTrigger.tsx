import { Badge, Button, Tooltip } from "antd";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function PrivateTelegramTrigger() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const telegram = useStore(state => state.privateTelegram);
  const expanded = useStore(state => state.privateTelegramExpanded);
  const linked = !!telegram?.link?.telegram_user_id;
  const title = !telegram?.gateway?.enabled ? t("nav.telegram.disabled")
    : linked ? t("nav.telegram.linked") : t("nav.telegram.configure");
  return <Tooltip title={title}>
    <Badge dot={linked} status="success">
      <Button type="text" className="wf-header-action" icon={<Icon name="message" size={16} />} aria-label={t("nav.telegram.settings")}
        aria-expanded={expanded} aria-controls="private-telegram-popover"
        onClick={() => store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: !expanded })} />
    </Badge>
  </Tooltip>;
}
