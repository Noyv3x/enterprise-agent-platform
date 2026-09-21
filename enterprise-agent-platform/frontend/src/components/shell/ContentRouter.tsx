import { lazy, Suspense, useEffect } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { useDispatch, useStore } from "../../store/useStore";
import { useI18n } from "../../i18n";
import type { ActiveView } from "../../types";
import { ChatView } from "../chat/ChatView";
import { TelegramLinkPopover } from "../chat/TelegramLinkPopover";
import { LoadingState } from "../ui/beautiful"
import { loadAdminRoute, loadSettingsRoute } from "./routePreload";

const SettingsView = lazy(() => loadSettingsRoute().then(module => ({ default: module.SettingsView })));
const AdminPanel = lazy(() => loadAdminRoute().then(module => ({ default: module.AdminPanel })));

export function ContentRouter() {
  const permissions = usePermissions();
  const view = useStore(state => state.activeView);
  const telegramExpanded = useStore(state => state.privateTelegramExpanded);
  const dispatch = useDispatch();
  const { t } = useI18n();
  const effective: ActiveView = !permissions.isAdmin && view === "admin" ? "channel"
    : !permissions.has("private_agent") && view === "private" ? "channel" : view;
  useEffect(() => {
    if (effective !== view) dispatch({ type: "SET_ACTIVE_VIEW", payload: effective });
  }, [dispatch, effective, view]);

  return <div className="bui-route" key={effective}>
    <Suspense fallback={<LoadingState label={t("common.loading")} />}>
      {effective === "settings" ? <SettingsView /> : effective === "admin" ? <AdminPanel /> : <ChatView mode={effective === "private" ? "private" : "channel"} />}
    </Suspense>
    {effective === "private" && telegramExpanded ? <TelegramLinkPopover /> : null}
  </div>;
}
