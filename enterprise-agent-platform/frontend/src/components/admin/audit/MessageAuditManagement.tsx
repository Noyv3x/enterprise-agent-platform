/* <MessageAuditManagement/> — the message-audit view with channel and private cards.
   It owns a shared confirmation dialog passed to both cards and computes the
   effective channel id. The default auditChannelId is set in an effect to avoid
   render-time store mutation. */

import { useEffect } from "react";
import { useConfirm } from "../../../hooks/useConfirm";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { ChannelAuditCard } from "./ChannelAuditCard";
import { PrivateAuditCard } from "./PrivateAuditCard";

export function MessageAuditManagement() {
  const store = useStoreHandle();
  const { confirm, dialog } = useConfirm();

  const auditChannelId = useStore((state) => state.messageAudit.auditChannelId);
  const channels = useStore((state) => state.channels);
  const activeChannelId = useStore((state) => state.activeChannelId);

  const channelId = String(auditChannelId || activeChannelId || channels[0]?.id || "");

  // Set the default in an effect so rendering never mutates the store.
  useEffect(() => {
    if (!auditChannelId && channelId) {
      store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditChannelId: channelId } });
    }
  }, [auditChannelId, channelId, store]);

  return (
    <div className="audit-grid">
      <ChannelAuditCard confirm={confirm} channelId={channelId} />
      <PrivateAuditCard confirm={confirm} />
      {dialog}
    </div>
  );
}
