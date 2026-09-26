import { useI18n, type Translator } from "../../i18n";
import type { Message } from "../../types";
import { StatusMark } from "../ui/fieldwork";
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

/** What must precede the content: the author (channels) and attention marks. */
export function MessageHeader({ message, isUser, showAuthor }: { message: Message; isUser: boolean; showAuthor: boolean }) {
  const { t } = useI18n();
  return <>
    {showAuthor && <strong className="wf-message-author">{authorName(message, isUser, t)}</strong>}
    {message.metadata?.needs_review && <StatusMark tone="warning">{t("chat.message.needsReview")}</StatusMark>}
  </>;
}

/** Live progress while sending/generating, otherwise the message time. */
export function MessageFootnote({ message, pending, streaming }: { message: Message; pending: boolean; streaming: boolean }) {
  const { t, locale } = useI18n();
  if (pending) return <StatusMark subtle busy tone="info">{t("chat.message.sending")}</StatusMark>;
  if (streaming) return <StatusMark subtle busy tone="info">{t("chat.message.generating")}</StatusMark>;
  const time = formatMessageTime(message.created_at, locale);
  return time ? <time className="wf-message-time" dateTime={new Date(message.created_at! * 1000).toISOString()}>{time}</time> : null;
}
