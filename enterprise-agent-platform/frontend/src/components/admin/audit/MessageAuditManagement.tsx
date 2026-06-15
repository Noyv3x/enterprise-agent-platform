/* <MessageAuditManagement/> — the message-audit view: channel card + private card
   (legacy renderMessageAuditManagement, legacy-app.js:1792-1944). Owns a single
   shared confirm dialog (useConfirm) passed to both cards, and computes the
   effective channel id with the legacy fallback chain. The legacy code set the
   default auditChannelId during render; here it's a useEffect (no render-time
   store mutation). */

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

  // Legacy set the default auditChannelId during render; do it in an effect so we
  // never mutate the store while rendering.
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
