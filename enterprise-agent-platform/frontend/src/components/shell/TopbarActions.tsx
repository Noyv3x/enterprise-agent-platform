import { useStore } from "../../store/useStore";
import { PrivateTelegramTrigger } from "./PrivateTelegramTrigger";
import { useChatPreviewContext } from "../preview/ChatPreviewContext";

export function TopbarActions() {
  const preview = useChatPreviewContext();
  const privateScope = useStore(state => state.activeView === "private");
  return <>
    {preview?.capabilityActions}
    {privateScope ? <PrivateTelegramTrigger /> : null}
  </>;
}
