import { Button } from "../../ui/beautiful";
import { useRef, useState } from "react";
import { refreshMessageAudit, selectAuditConversation } from "../../../data/adminActions";
import type { UseConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { EmptyState, ResourceList, Section, SplitDetail } from "../../ui/beautiful";
import { AuditThread } from "./AuditThread";
import { PrivateConversationItem } from "./PrivateConversationItem";

export interface PrivateAuditCardProps { confirm: UseConfirm["confirm"]; }

export function PrivateAuditCard({ confirm }: PrivateAuditCardProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const audit = useStore((state) => state.messageAudit);
  const pending = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:audit:")));
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(true);
  const request = useRef(0);
  const scopeId = String(audit.auditPrivateUserId || "");
  const selected = audit.privateConversations.find((item) => String(item.user_id) === scopeId);
  async function read(userId?: string) {
    const version = ++request.current;
    setLoading(true);
    if (userId !== undefined) setDetailOpen(true);
    try {
      if (userId !== undefined) await selectAuditConversation(store, userId);
      else await refreshMessageAudit(store);
    } finally {
      if (request.current === version) setLoading(false);
    }
  }
  return <Section title={t("admin.audit.private.title")} description={t("admin.audit.private.userCount", { count: audit.privateConversations.length })} actions={<Button disabled={pending} onClick={() => { void read(); }}>{t("admin.common.refresh")}</Button>}>
    <SplitDetail
      detailOpen={detailOpen && !!selected}
      onBack={() => setDetailOpen(false)}
      backLabel={t("admin.audit.private.selectHint")}
      list={audit.privateConversations.length ? <ResourceList label={t("admin.audit.private.title")}>
        {audit.privateConversations.map((item) => <PrivateConversationItem key={item.user_id} item={item} active={String(item.user_id) === scopeId} onSelect={() => { void read(String(item.user_id)); }} />)}
      </ResourceList> : <EmptyState compact title={loading ? t("common.loading") : t("admin.audit.private.noUsers")} />}
      detail={selected ? <AuditThread key={scopeId} kind="private" scopeId={scopeId} scopeName={selected.display_name || selected.username || scopeId} messages={audit.privateMessages} total={audit.privateTotal} loading={loading} confirm={confirm} /> : <EmptyState compact title={t("admin.audit.private.selectHint")} />}
    />
  </Section>;
}
