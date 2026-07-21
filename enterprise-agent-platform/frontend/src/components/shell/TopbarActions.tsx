/* Contextual topbar actions only. Persistent language/theme controls live in the
   user menu to keep this header focused on the active workspace. */

import { useStore } from "../../store/useStore";
import { ContextDetailsDialog } from "../chat/ContextDetailsDialog";
import { PrivateTelegramTrigger } from "./PrivateTelegramTrigger";

export function TopbarActions() {
  const activeView = useStore((state) => state.activeView);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const activeMessages = useStore((state) => (
    state.activeView === "private" ? state.privateMessages : state.messages
  ));
  const isPrivate = activeView === "private";
  const isChat = isPrivate || (activeView === "channel" && activeChannelId != null);
  return (
    <div className="topbar__actions">
      {isChat ? (
        <ContextDetailsDialog messages={activeMessages} />
      ) : null}
      {isPrivate ? <PrivateTelegramTrigger /> : null}
    </div>
  );
}
