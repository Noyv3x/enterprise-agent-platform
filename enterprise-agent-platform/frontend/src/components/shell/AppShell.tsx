import { useCallback, useEffect, useState } from "react";
import { ensureCurrentUserTimezone } from "../../data/accountActions";
import { useBranding } from "../../context/BrandingContext";
import { usePolling } from "../../hooks/usePolling";
import { useRealtime } from "../../hooks/useRealtime";
import { useReplyNotifications } from "../../hooks/useReplyNotifications";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { topbarInfo } from "../../store/selectors";
import { AppFrame } from "../ui/fieldwork";
import { PublicUtilities } from "../ui/PublicUtilities";
import { ContentRouter } from "./ContentRouter";
import { PersonalAiComposerFocusContext } from "./PersonalAiGuideContext";
import { PersonalAiGuideDialog } from "./PersonalAiGuideDialog";
import { useChannelDeletion, WorkspaceNav } from "./WorkspaceNav";
import { UserMenu } from "./UserMenu";
import "./shell.css";

export function AppShell() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const { branding } = useBranding();
  const userId = useStore(state => state.user?.id);
  const userTimezone = useStore(state => state.user?.timezone);
  const navigationOpen = useStore(state => state.sidebarOpen);
  const deletion = useChannelDeletion();
  const setNavigationOpen = useCallback((open: boolean) => store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: open }), [store]);
  const destination = useStore(state => topbarInfo(state, t).title);
  const [focusToken, setFocusToken] = useState(0);
  const requestFocus = useCallback(() => setFocusToken(token => token + 1), []);
  const connected = useRealtime();
  usePolling(connected ? 30_000 : 4_000);
  useReplyNotifications();
  useEffect(() => {
    if (userId != null) void ensureCurrentUserTimezone(store, userId, userTimezone).catch(() => undefined);
  }, [store, userId, userTimezone]);
  return <PersonalAiComposerFocusContext.Provider value={focusToken}>
    <AppFrame brand={{ productName: branding.product_name, logoUrl: branding.logo_url }}
      navigationOpen={navigationOpen} onNavigationOpenChange={setNavigationOpen}
      navigation={<><WorkspaceNav onDelete={deletion.beginDelete} deleteBusy={deletion.busy} />{deletion.retryAction}</>} account={<UserMenu />} utilities={<PublicUtilities />}
      navigationLabel={t("shell.navigation")} openNavigationLabel={t("nav.menu.open")}
      closeNavigationLabel={t("common.close")} skipLabel={t("shell.skipToContent")} mobileTitle={destination}>
      <ContentRouter />
    </AppFrame>
    <PersonalAiGuideDialog onDraftFilled={requestFocus} />
    {deletion.confirmation}
  </PersonalAiComposerFocusContext.Provider>;
}
