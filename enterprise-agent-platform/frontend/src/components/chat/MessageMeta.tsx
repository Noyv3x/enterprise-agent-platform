/* <MessageMeta/> — the bubble meta row (legacy renderMessage meta, :884-889):
   author name, optional pending/streaming badges, and the formatted time. */

import { formatTime } from "../../utils/format";
import type { Message } from "../../types";

export function MessageMeta({
  message,
  isUser,
  pending,
  streaming,
}: {
  message: Message;
  isUser: boolean;
  pending: boolean;
  streaming: boolean;
}) {
  return (
    <div className="msg__meta">
      <span className="msg__name">{message.username || (isUser ? "你" : "Agent")}</span>
      {pending ? <span className="msg__pending">发送中</span> : null}
      {streaming ? <span className="msg__pending">生成中</span> : null}
      <span className="msg__time">{formatTime(message.created_at)}</span>
    </div>
  );
}
