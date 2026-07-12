/* <TypingUsers/> — the channel-only "X 正在输入" indicator (legacy
   renderTypingUsers, :1175-1181). Up to 3 names joined by "、". */

import type { TypingUser } from "../../types";
import { useI18n } from "../../i18n";

export function TypingUsers({ users }: { users: TypingUser[] }) {
  const { locale, t } = useI18n();
  const visibleNames = users
    .map((user) => user.username)
    .filter(Boolean)
    .slice(0, 3) as string[];
  const names = visibleNames.join(locale === "en" ? ", " : "、");
  return (
    <div className="typing-line">
      <span>
        {names
          ? t("chat.typing.users", { names, count: visibleNames.length })
          : t("chat.typing.someone")}
      </span>
      <div className="typing__dots">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
