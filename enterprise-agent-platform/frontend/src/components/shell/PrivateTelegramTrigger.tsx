/* <PrivateTelegramTrigger/> — the topbar Telegram action shown only on the
   private view (legacy renderPrivateTelegramAction, legacy-app.js:538-559).
   Toggles privateTelegramExpanded; the active button and Ant badge communicate
   expanded and linked state. aria-controls ties to the link dialog. */

import { Badge, Button, Tooltip } from "antd";
import { cx } from "../../lib/cx";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function PrivateTelegramTrigger() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const privateTelegram = useStore((state) => state.privateTelegram);
  const expanded = useStore((state) => state.privateTelegramExpanded);

  const gateway = privateTelegram?.gateway || {};
  const link = privateTelegram?.link || {};
  const linked = !!link.telegram_user_id;
  const title = gateway.enabled
    ? linked
      ? t("nav.telegram.linked")
      : t("nav.telegram.configure")
    : t("nav.telegram.disabled");

  return (
    <Tooltip title={title}>
      <Badge dot={linked} status="success" offset={[-5, 5]}>
        <Button
          className={cx("private-telegram-trigger", expanded && "is-active")}
          type="text"
          icon={<Icon name="message" />}
          aria-label={t("nav.telegram.settings")}
          aria-expanded={expanded}
          aria-controls="private-telegram-popover"
          onClick={() =>
            store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: !expanded })
          }
        />
      </Badge>
    </Tooltip>
  );
}
