import { useStore } from "../../store/useStore";
import { ContextDetailsDialog } from "../chat/ContextDetailsDialog";
import { PrivateTelegramTrigger } from "./PrivateTelegramTrigger";
import { useChatPreviewContext } from "../preview/ChatPreviewContext";

export function TopbarActions() {
  const preview = useChatPreviewContext();
  const view = useStore(state => state.activeView);
  const channelId = useStore(state => state.activeChannelId);
  const messages = useStore(state => state.activeView === "private" ? state.privateMessages : state.messages);
  const privateScope = view === "private";
  const chat = privateScope || (view === "channel" && channelId != null);
  return <>
    {preview?.capabilityActions}
    {chat ? <ContextDetailsDialog messages={messages} /> : null}
    {privateScope ? <PrivateTelegramTrigger /> : null}
  </>;
}
