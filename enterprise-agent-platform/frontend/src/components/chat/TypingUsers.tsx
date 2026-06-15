/* <TypingUsers/> — the channel-only "X 正在输入" indicator (legacy
   renderTypingUsers, :1175-1181). Up to 3 names joined by "、". */

import type { TypingUser } from "../../types";

export function TypingUsers({ users }: { users: TypingUser[] }) {
  const names = users
    .map((user) => user.username)
    .filter(Boolean)
    .slice(0, 3)
    .join("、");
  return (
    <div className="typing-line">
      <span>{`${names || "有人"} 正在输入`}</span>
      <div className="typing__dots">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
