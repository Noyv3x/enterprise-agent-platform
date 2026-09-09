import { useI18n } from "../../../i18n";
import type { PrivateConversation } from "../../../types";
import { formatTimestamp } from "../../../utils/format";
import { ResourceRow } from "../../ui/fieldwork";

export interface PrivateConversationItemProps {
  item: PrivateConversation;
  active: boolean;
  onSelect: () => void;
}

export function PrivateConversationItem({ item, active, onSelect }: PrivateConversationItemProps) {
  const { t } = useI18n();
  const name = item.display_name || item.username || String(item.user_id);
  return <ResourceRow
    title={name}
    description={item.username ? `@${item.username}` : `#${item.user_id}`}
    meta={<>{t("admin.audit.messageCount", { count: item.message_count || 0 })} · {item.last_message_at ? formatTimestamp(item.last_message_at) : t("admin.audit.noRecord")}</>}
    selected={active}
    onSelect={onSelect}
    selectLabel={name}
  />;
}
