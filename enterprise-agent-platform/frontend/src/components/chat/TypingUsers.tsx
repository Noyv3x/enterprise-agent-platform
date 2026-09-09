import type { TypingUser } from "../../types";
import { useI18n } from "../../i18n";
import { StatusMark } from "../ui/fieldwork";

export function TypingUsers({ users }: { users: TypingUser[] }) {
  const { locale, t } = useI18n();
  const visibleNames = users.map((user) => user.username).filter(Boolean).slice(0, 3) as string[];
  const names = visibleNames.join(locale === "en" ? ", " : "、");
  return <div role="status" aria-live="polite"><StatusMark subtle>{names ? t("chat.typing.users", { names, count: visibleNames.length }) : t("chat.typing.someone")}</StatusMark></div>;
}
