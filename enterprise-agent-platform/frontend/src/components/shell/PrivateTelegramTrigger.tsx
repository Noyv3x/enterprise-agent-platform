import { Button, Tooltip } from "../ui/beautiful";
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
    <span className="bui-telegram-trigger" data-linked={linked || undefined}>
      <Button icon={<Icon name="message" />} aria-label={t("nav.telegram.settings")}
        aria-expanded={expanded} aria-controls="private-telegram-popover"
        onClick={() => store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: !expanded })} />
    </span>
  </Tooltip>;
}
