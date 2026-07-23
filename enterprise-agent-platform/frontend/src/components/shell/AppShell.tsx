/* <AppShell/> — the authenticated two-column layout: the product-owned desktop
   sidebar and main column remain custom structure, while Ant Design Drawer owns
   the mobile overlay, focus, Escape, and mask-dismiss behavior.

   The SSE stream + safety poll are shell-owned (legacy
   syncScopeStream/startPolling ran globally from afterRender/boot, not per chat
   view), so useRealtime + usePolling mount here and track the active scope.

*/

import { Drawer } from "antd";
import { useEffect } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePolling } from "../../hooks/usePolling";
import { useRealtime } from "../../hooks/useRealtime";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { ContentRouter } from "./ContentRouter";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { ensureCurrentUserTimezone } from "../../data/accountActions";
import { Brand } from "../common/Brand";
import { Icon } from "../common/Icon";

export function AppShell() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const userId = useStore((state) => state.user?.id);
  const userTimezone = useStore((state) => state.user?.timezone);
  const isMobile = useMediaQuery("(max-width: 800px)");

  // A connected stream uses cheap revision events for normal delivery. Keep a
  // low-frequency watchdog as well: if the one GET triggered by an SSE event
  // crosses a transient tunnel failure, the unchanged stream has no reason to
  // emit that same event again.
  const realtimeConnected = useRealtime();
  usePolling(realtimeConnected ? 30_000 : 4_000);

  useEffect(() => {
    if (userId == null) return;
    void ensureCurrentUserTimezone(store, userId, userTimezone).catch(() => undefined);
  }, [store, userId, userTimezone]);

  useEffect(() => {
    if (!isMobile && sidebarOpen) {
      store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
    }
  }, [isMobile, sidebarOpen, store]);

  const closeSidebar = () => store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });

  return (
    <>
      <a className="skip-link" href="#main-content">{t("shell.skipToContent")}</a>
      <div className="shell">
        {isMobile ? (
          <Drawer
            rootClassName="shell-drawer"
            placement="left"
            size="min(86vw, 300px)"
            open={sidebarOpen}
            onClose={closeSidebar}
            title={<Brand />}
            closeIcon={<Icon name="close" />}
            destroyOnHidden
            mask={{ closable: true }}
            classNames={{
              header: "shell-drawer__header",
              section: "shell-drawer__section",
              body: "shell-drawer__body",
              close: "shell-drawer__close",
            }}
          >
            <Sidebar showBrand={false} />
          </Drawer>
        ) : (
          <Sidebar />
        )}
        <main
          className="main"
          id="main-content"
          tabIndex={-1}
        >
          <Topbar />
          <ContentRouter />
        </main>
      </div>
    </>
  );
}
