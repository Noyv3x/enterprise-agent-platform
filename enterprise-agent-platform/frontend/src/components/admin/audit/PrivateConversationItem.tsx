/* <PrivateConversationItem/> — one selectable private-conversation entry in the
   audit list (legacy renderPrivateConversationItem, legacy-app.js:1946-1963). */

import { cx } from "../../../lib/cx";
import { Button } from "antd";
import { formatTimestamp, initials } from "../../../utils/format";
import type { PrivateConversation } from "../../../types";
import { useI18n } from "../../../i18n";

export interface PrivateConversationItemProps {
  item: PrivateConversation;
  active: boolean;
  onSelect: () => void;
}

export function PrivateConversationItem({ item, active, onSelect }: PrivateConversationItemProps) {
  const { t } = useI18n();
  return (
    <Button
      className={cx("audit-conversation", active && "is-active")}
      type="text"
      style={{
        height: "auto",
        background: active ? "var(--accent-soft)" : "var(--surface-2)",
        borderColor: active ? "var(--accent-line)" : "var(--line)",
      }}
      onClick={onSelect}
    >
      <div className="avatar">{initials(item.display_name || item.username)}</div>
      <div className="audit-conversation__main">
        <strong>{item.display_name || item.username}</strong>
        <span>{item.last_message_at ? formatTimestamp(item.last_message_at) : t("admin.audit.noRecord")}</span>
      </div>
      <span className="nav__badge">{String(item.message_count || 0)}</span>
    </Button>
  );
}
