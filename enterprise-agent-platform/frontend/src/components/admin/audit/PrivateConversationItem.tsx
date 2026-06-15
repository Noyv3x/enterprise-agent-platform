/* <PrivateConversationItem/> — one selectable private-conversation entry in the
   audit list (legacy renderPrivateConversationItem, legacy-app.js:1946-1963). */

import { cx } from "../../../lib/cx";
import { formatTimestamp, initials } from "../../../utils/format";
import type { PrivateConversation } from "../../../types";

export interface PrivateConversationItemProps {
  item: PrivateConversation;
  active: boolean;
  onSelect: () => void;
}

export function PrivateConversationItem({ item, active, onSelect }: PrivateConversationItemProps) {
  return (
    <button
      className={cx("audit-conversation", active && "is-active")}
      type="button"
      onClick={onSelect}
    >
      <div className="avatar">{initials(item.display_name || item.username)}</div>
      <div className="audit-conversation__main">
        <strong>{item.display_name || item.username}</strong>
        <span>{item.last_message_at ? formatTimestamp(item.last_message_at) : "暂无记录"}</span>
      </div>
      <span className="nav__badge">{String(item.message_count || 0)}</span>
    </button>
  );
}
