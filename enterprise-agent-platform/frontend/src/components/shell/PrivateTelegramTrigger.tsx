/* <PrivateTelegramTrigger/> — the topbar Telegram action shown only on the
   private view (legacy renderPrivateTelegramAction, legacy-app.js:538-559).
   Toggles privateTelegramExpanded; .is-active when expanded, .is-linked (green
   dot via CSS) when a Telegram user is bound. aria-controls ties to the popover
   id the private-agent spec (Phase 4a) renders. */

import { cx } from "../../lib/cx";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function PrivateTelegramTrigger() {
  const store = useStoreHandle();
  const privateTelegram = useStore((state) => state.privateTelegram);
  const expanded = useStore((state) => state.privateTelegramExpanded);

  const gateway = privateTelegram?.gateway || {};
  const link = privateTelegram?.link || {};
  const linked = !!link.telegram_user_id;
  const title = gateway.enabled
    ? linked
      ? "Telegram 私聊已绑定"
      : "配置 Telegram 私聊"
    : "Telegram 私聊未启用";

  return (
    <button
      className={cx("icon-btn", "private-telegram-trigger", expanded && "is-active", linked && "is-linked")}
      type="button"
      title={title}
      aria-label="Telegram 私聊设置"
      aria-expanded={expanded}
      aria-controls="private-telegram-popover"
      onClick={() =>
        store.dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: !expanded })
      }
    >
      <Icon name="message" />
    </button>
  );
}
