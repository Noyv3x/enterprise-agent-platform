/* <TelegramLinkPopover/> — the private-mode Telegram link popover (legacy
   renderPrivateTelegramConfig, legacy-app.js:745-816). A role=dialog popover (the
   topbar trigger's aria-controls target id="private-telegram-popover") to bind /
   unbind the user's Telegram account to their private agent.

   The two inputs are controlled useState seeded from the current link at mount
   (the popover is mounted only while expanded, so reopening reflects fresh server
   values). Save = PUT, unbind = DELETE with the literal "{}" body; both run through
   runBusy (global busy disables the buttons) and reload via loadPrivateTelegram. */

import { useState } from "react";
import { api } from "../../lib/api";
import { EMPTY_BODY, endpoints } from "../../lib/endpoints";
import { runBusy } from "../../data/sessionActions";
import { loadPrivateTelegram } from "../../data/loaders";
import { useToast } from "../../hooks/useToast";
import { useDispatch, useStore, useStoreHandle } from "../../store/useStore";
import { Field } from "../common/Field";
import { Icon } from "../common/Icon";

export function TelegramLinkPopover() {
  const store = useStoreHandle();
  const dispatch = useDispatch();
  const toast = useToast();

  const busy = useStore((state) => state.busy);
  const telegram = useStore((state) => state.privateTelegram);

  const gateway = telegram?.gateway || {};
  const link = telegram?.link || {};
  const linked = !!link.telegram_user_id;
  const botName = gateway.bot_username ? `@${gateway.bot_username}` : "Telegram bot";
  const status = gateway.enabled ? `${botName} ${linked ? "已绑定" : "可绑定"}` : "管理员尚未启用";

  const [telegramId, setTelegramId] = useState(String(link.telegram_user_id || ""));
  const [telegramUsername, setTelegramUsername] = useState(link.telegram_username || "");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await runBusy(store, async () => {
      await api(endpoints.updatePrivateTelegram.path(), {
        method: "PUT",
        body: JSON.stringify({ telegram_user_id: telegramId, telegram_username: telegramUsername }),
      });
      await loadPrivateTelegram(store);
      toast("Telegram 绑定已保存", { type: "ok", title: "完成" });
    });
  };

  const onUnbind = async () => {
    await runBusy(store, async () => {
      await api(endpoints.deletePrivateTelegram.path(), { method: "DELETE", body: EMPTY_BODY });
      await loadPrivateTelegram(store);
      toast("Telegram 绑定已解除", { type: "ok", title: "完成" });
    });
  };

  return (
    <section className="telegram-link" id="private-telegram-popover" role="dialog" aria-label="Telegram 私聊设置">
      <div className="telegram-link__header">
        <div className="telegram-link__meta">
          <div className="telegram-link__title">
            <Icon name="message" size={16} />
            <span>Telegram 私聊</span>
          </div>
          <div className="telegram-link__sub">{status}</div>
        </div>
        <button
          className="icon-btn telegram-link__close"
          type="button"
          title="收起"
          aria-label="收起 Telegram 私聊设置"
          onClick={() => dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false })}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <form className="telegram-link__form" onSubmit={onSubmit}>
        <Field label="Telegram ID">
          <input
            value={telegramId}
            onChange={(event) => setTelegramId(event.target.value)}
            placeholder="例如 123456789"
            inputMode="numeric"
          />
        </Field>
        <Field label="Telegram 用户名">
          <input
            value={telegramUsername}
            onChange={(event) => setTelegramUsername(event.target.value)}
            placeholder="可选，不带 @"
          />
        </Field>
        <div className="telegram-link__actions">
          <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>
            <span>{linked ? "更新绑定" : "保存绑定"}</span>
          </button>
          {linked ? (
            <button className="btn btn--danger btn--sm" type="button" disabled={busy} onClick={onUnbind}>
              <span>解除</span>
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
