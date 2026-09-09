import { navigateToView, selectChannel } from "../../data/chatActions";
import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";
import { WorkspaceNav as FieldworkNavigation, type NavigationGroup } from "../ui/fieldwork";
import { ChannelCreateForm } from "./ChannelCreateForm";
import { preloadRoute } from "./routePreload";

export function WorkspaceNav() {
  const store = useStoreHandle();
  const permissions = usePermissions();
  const { t } = useI18n();
  const channels = useStore(state => state.channels);
  const view = useStore(state => state.activeView);
  const channelId = useStore(state => state.activeChannelId);
  const groups: NavigationGroup[] = [];
  if (permissions.has("private_agent")) groups.push({
    key: "personal", label: null, items: [
      { key: "private", label: t("nav.privateAgent"), icon: <Icon name="bot" /> },
      { key: "guide", label: t("personalAi.guide.sidebar"), icon: <Icon name="sparkles" /> },
    ],
  });
  groups.push({ key: "channels", label: <span><Icon name="users" /> {t("nav.channels")}</span>,
    action: permissions.has("manage_channels") ? <ChannelCreateForm /> : undefined,
    items: channels.length ? channels.map(channel => ({ key: `channel:${String(channel.id)}`, label: channel.name,
      description: <span className="wf-stack-tight"><span>{t("nav.channels.memberVisible")}</span>{channel.description ? <span>{channel.description}</span> : null}</span>, icon: <Icon name="hash" /> }))
      : [{ key: "no-channels", label: t("nav.channels.empty"), description: t("nav.channels.visibility"), disabled: true }],
  });
  groups.push({ key: "tools", label: null, items: [
    { key: "settings", label: <span onPointerEnter={() => preloadRoute("settings")} onTouchStart={() => preloadRoute("settings")}>{t("nav.settings")}</span>, icon: <Icon name="settings" /> },
    ...(permissions.isAdmin ? [{ key: "admin", label: <span onPointerEnter={() => preloadRoute("admin")} onTouchStart={() => preloadRoute("admin")}>{t("nav.admin")}</span>, icon: <Icon name="shield" /> }] : []),
  ] });
  return <FieldworkNavigation label={t("shell.navigation")} groups={groups}
    activeKey={view === "channel" ? `channel:${String(channelId)}` : view}
    onSelect={key => {
      if (key.startsWith("channel:")) {
        const selected = channels.find(channel => `channel:${String(channel.id)}` === key);
        if (selected) void selectChannel(store, selected.id);
      } else if (key === "guide") {
        void navigateToView(store, "private");
        store.dispatch({ type: "SET_PERSONAL_AI_GUIDE_OPEN", payload: { open: true, markShown: true } });
      } else if (key === "private" || key === "settings" || key === "admin") {
        void navigateToView(store, key);
      }
    }} />;
}
