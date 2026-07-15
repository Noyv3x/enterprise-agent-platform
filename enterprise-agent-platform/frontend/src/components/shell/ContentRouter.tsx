/* <ContentRouter/> — the main content-area router (legacy renderContent,
   legacy-app.js:573-585). Switches on activeView and applies the per-view
   .view-enter entrance animation (replayed by keying the section on the view, so
   the CSS keyframe runs once per view change; reduced-motion is handled in CSS).

   Permission view-fallback guard (legacy renderShell guard, legacy-app.js:408-409):
   a demoted/limited user must never be stuck on a forbidden view. We render the
   COERCED ("effective") view immediately, and persist the coercion to the store
   in an effect so the rest of the tree (nav highlight, topbar) follows.

   Realtime/poll note: AppShell owns useRealtime()/usePolling() — the views must
   not mount them again, so this router only selects which view subtree renders. */

import { useEffect } from "react";
import { cx } from "../../lib/cx";
import { usePermissions } from "../../hooks/usePermissions";
import { useDispatch, useStore } from "../../store/useStore";
import type { ActiveView } from "../../types";
import { ChatView } from "../chat/ChatView";
import { TelegramLinkPopover } from "../chat/TelegramLinkPopover";
import { KnowledgeView } from "../knowledge/KnowledgeView";
import { AdminPanel } from "../admin/AdminPanel";
import { SettingsView } from "../settings/SettingsView";
import { BrowserPreviewView } from "../preview/BrowserPreviewView";
import { TerminalPreviewView } from "../preview/TerminalPreviewView";

/* ------------------------------------------------------------- router */

export function ContentRouter() {
  const perms = usePermissions();
  const view = useStore((state) => state.activeView);
  const telegramExpanded = useStore((state) => state.privateTelegramExpanded);
  const dispatch = useDispatch();

  // Coerce away from a forbidden view (silent redirect to channel).
  const effective: ActiveView =
    !perms.isAdmin && view === "admin"
      ? "channel"
      : !perms.has("private_agent") && view === "private"
        ? "channel"
        : view;

  useEffect(() => {
    if (effective !== view) dispatch({ type: "SET_ACTIVE_VIEW", payload: effective });
  }, [effective, view, dispatch]);

  let body: React.ReactNode;
  if (effective === "private") body = <ChatView mode="private" />;
  else if (effective === "knowledge") body = <KnowledgeView />;
  else if (effective === "browserPreview") body = <BrowserPreviewView />;
  else if (effective === "terminalPreview") body = <TerminalPreviewView />;
  else if (effective === "settings") body = <SettingsView />;
  else if (effective === "admin") body = <AdminPanel />;
  else body = <ChatView mode="channel" />;

  return (
    // key on the effective view replays the .view-enter keyframe once per change.
    <section className={cx("content", "view-enter")} key={effective}>
      {body}
      {effective === "private" && telegramExpanded ? <TelegramLinkPopover /> : null}
    </section>
  );
}
