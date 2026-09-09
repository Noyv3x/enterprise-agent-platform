import { Segmented } from "antd";
import { useEffect, useState } from "react";
import { selectAuditChannel } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { ChannelAuditCard } from "./ChannelAuditCard";
import { PrivateAuditCard } from "./PrivateAuditCard";

export function MessageAuditManagement() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const { confirm, dialog } = useConfirm();
  const [source, setSource] = useState<"channel" | "private">("channel");
  const auditChannelId = useStore((state) => state.messageAudit.auditChannelId);
  const channels = useStore((state) => state.channels);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const channelId = String(auditChannelId || activeChannelId || channels[0]?.id || "");
  useEffect(() => {
    if (!auditChannelId && channelId) void selectAuditChannel(store, channelId);
  }, [auditChannelId, channelId, store]);
  return <>
    <Segmented value={source} onChange={setSource} options={[{ value: "channel", label: t("admin.audit.channel.label") }, { value: "private", label: t("admin.audit.private.title") }]} />
    {source === "channel" ? <ChannelAuditCard confirm={confirm} channelId={channelId} /> : <PrivateAuditCard confirm={confirm} />}
    {dialog}
  </>;
}
