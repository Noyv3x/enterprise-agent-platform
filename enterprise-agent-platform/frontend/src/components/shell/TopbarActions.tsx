/* Contextual topbar actions only. Persistent language/theme controls live in the
   user menu to keep this header focused on the active workspace. */

import { useStore } from "../../store/useStore";
import { PrivateTelegramTrigger } from "./PrivateTelegramTrigger";

export function TopbarActions() {
  const isPrivate = useStore((state) => state.activeView === "private");
  return (
    <div className="topbar__actions">
      {isPrivate ? <PrivateTelegramTrigger /> : null}
    </div>
  );
}
