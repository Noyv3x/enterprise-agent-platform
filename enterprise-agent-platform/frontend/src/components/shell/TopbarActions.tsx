/* <TopbarActions/> — right-aligned topbar actions (legacy-app.js:521-524, 534).
   The private-Telegram trigger appears only on the private view; the theme toggle
   is always last/right. */

import { useStore } from "../../store/useStore";
import { ThemeToggle } from "../common/ThemeToggle";
import { PrivateTelegramTrigger } from "./PrivateTelegramTrigger";

export function TopbarActions() {
  const isPrivate = useStore((state) => state.activeView === "private");
  return (
    <div className="topbar__actions">
      {isPrivate ? <PrivateTelegramTrigger /> : null}
      <ThemeToggle />
    </div>
  );
}
