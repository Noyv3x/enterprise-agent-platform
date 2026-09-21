import type { ReactNode } from "react";
import { useI18n, type Translator } from "../../i18n";
import type { Message } from "../../types";
import { StatusMark } from "../ui/beautiful"
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

export function MessageMeta({message,isUser,pending,streaming,hideAuthorName=false,action}: {
 message:Message; isUser:boolean; pending:boolean; streaming:boolean; hideAuthorName?:boolean; action?:ReactNode;
}) {
 const {t,locale}=useI18n();
 return <div className="bui-message-metadata">
   {!hideAuthorName && <strong>{authorName(message,isUser,t)}</strong>}
   <time dateTime={message.created_at ? new Date(message.created_at * 1000).toISOString() : undefined}>{formatMessageTime(message.created_at,locale)}</time>
   {message.metadata?.needs_review && <StatusMark tone="warning">{t("chat.message.needsReview")}</StatusMark>}
   {pending && <StatusMark tone="info">{t("chat.message.sending")}</StatusMark>}
   {streaming && <StatusMark tone="info">{t("chat.message.generating")}</StatusMark>}
   {action}
 </div>;
}
