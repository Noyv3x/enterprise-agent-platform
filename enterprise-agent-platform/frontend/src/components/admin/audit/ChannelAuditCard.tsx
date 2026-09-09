import { Button, Form, Select } from "antd";
import { useRef, useState } from "react";
import { refreshAuditChannel, selectAuditChannel } from "../../../data/adminActions";
import type { UseConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { EmptyState, Section } from "../../ui/fieldwork";
import { AuditThread } from "./AuditThread";

export interface ChannelAuditCardProps { confirm: UseConfirm["confirm"]; channelId: string; }

export function ChannelAuditCard({ confirm, channelId }: ChannelAuditCardProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const channels = useStore((state) => state.channels);
  const audit = useStore((state) => state.messageAudit);
  const pending = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:audit:")));
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const channel = channels.find((item) => String(item.id) === channelId);
  async function read(id: string, select: boolean) {
    const version = ++request.current;
    setLoading(true);
    try {
      if (select) await selectAuditChannel(store, id);
      else await refreshAuditChannel(store, id);
    } finally {
      if (request.current === version) setLoading(false);
    }
  }
  return <Section title={t("admin.audit.channel.title")} description={t("admin.audit.channel.selectHint")} actions={<Button disabled={!channel || pending} onClick={() => { void read(channelId, false); }}>{t("admin.common.refresh")}</Button>}>
    <Form layout="vertical"><Form.Item label={t("admin.audit.channel.label")}>
      <Select aria-label={t("admin.audit.channel.label")} value={channelId || undefined} options={channels.map((item) => ({ value: String(item.id), label: item.name }))} onChange={(id) => { void read(id, true); }} />
    </Form.Item></Form>
    {channel ? <AuditThread key={channelId} kind="channel" scopeId={channelId} scopeName={channel.name} messages={audit.auditChannelId === channelId ? audit.channelMessages : []} total={audit.auditChannelId === channelId ? audit.channelTotal : 0} loading={loading} confirm={confirm} /> : <EmptyState compact title={t(channels.length ? "admin.audit.channel.selectHint" : "admin.audit.channel.none")} />}
  </Section>;
}
