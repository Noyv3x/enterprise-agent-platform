/* <MessageMeta/> — the bubble meta row (legacy renderMessage meta, :884-889):
   author name, optional pending/streaming badges, and the formatted time. */

import { useI18n, type Translator } from "../../i18n";
import type { Message } from "../../types";
import type { ReactNode } from "react";

function formatMessageTime(value: number | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${time}`;
}

function authorName(message: Message, isUser: boolean, translate: Translator): string {
  if (isUser) return message.username || translate("chat.you");
  if (message.username === "Private Agent") return translate("chat.privateAgent");
  if (message.username === "Main Agent") return translate("chat.mainAgent");
  return message.username || translate("chat.agent");
}

export function MessageMeta({
  message,
  isUser,
  pending,
  streaming,
  action,
}: {
  message: Message;
  isUser: boolean;
  pending: boolean;
  streaming: boolean;
  action?: ReactNode;
}) {
  const { locale, t } = useI18n();
  return (
    <div className="msg__meta">
      <span className="msg__name">{authorName(message, isUser, t)}</span>
      {pending ? <span className="msg__pending">{t("chat.message.sending")}</span> : null}
      {streaming ? <span className="msg__pending">{t("chat.message.generating")}</span> : null}
      <span className="msg__time">{formatMessageTime(message.created_at, locale)}</span>
      {action}
    </div>
  );
}
