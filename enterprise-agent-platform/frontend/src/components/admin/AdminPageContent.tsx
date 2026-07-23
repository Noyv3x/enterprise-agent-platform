/* <AdminPageContent pageId/> — the admin page dispatch table (legacy
   renderAdminPageSections, legacy-app.js:1410-1423). Maps each page id to its
   section component(s).

   The Agent runtime page combines provider authorization with neutral runtime
   settings; managed service and platform settings remain on their own pages:
     agent-runtime → <OAuthSettings/> + <AgentRuntimeConfig/>
     telegram → <TelegramAdminConfig/>
     updates  → <AutoUpdateConfig/>
     security → <SecuritySettings/>
     runtime  → <RuntimeSettings/>
     cognee   → <CogneeInternalConfig/>
     secrets  → <SecretsSettings/> */

import { lazy, Suspense, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { AdminPageId } from "../../types";
import { Spinner } from "../common/Spinner";
import { AccountManagement } from "./accounts/AccountManagement";

const MessageAuditManagement = lazy(() => import("./audit/MessageAuditManagement").then(
  (module) => ({ default: module.MessageAuditManagement }),
));
const TokenUsageMonitoring = lazy(() => import("./tokens/TokenUsageMonitoring").then(
  (module) => ({ default: module.TokenUsageMonitoring }),
));
const AutoUpdateConfig = lazy(() => import("./config/AutoUpdateConfig").then(
  (module) => ({ default: module.AutoUpdateConfig }),
));
const CogneeInternalConfig = lazy(() => import("./config/CogneeInternalConfig").then(
  (module) => ({ default: module.CogneeInternalConfig }),
));
const AgentRuntimeConfig = lazy(() => import("./config/AgentRuntimeConfig").then(
  (module) => ({ default: module.AgentRuntimeConfig }),
));
const RuntimeSettings = lazy(() => import("./config/RuntimeSettings").then(
  (module) => ({ default: module.RuntimeSettings }),
));
const SecuritySettings = lazy(() => import("./config/SecuritySettings").then(
  (module) => ({ default: module.SecuritySettings }),
));
const TelegramAdminConfig = lazy(() => import("./config/TelegramAdminConfig").then(
  (module) => ({ default: module.TelegramAdminConfig }),
));
const OAuthSettings = lazy(() => import("./oauth/OAuthSettings").then(
  (module) => ({ default: module.OAuthSettings }),
));
const SecretsSettings = lazy(() => import("./secrets/SecretsSettings").then(
  (module) => ({ default: module.SecretsSettings }),
));

function AdminPageSuspense({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Suspense fallback={(
      <div className="eap-admin-page-loading" role="status" aria-label={t("common.loading")}>
        <Spinner size={22} />
      </div>
    )}>
      {children}
    </Suspense>
  );
}

export function AdminPageContent({
  pageId,
  accountCreateOpen = false,
  onCloseAccountCreate = () => {},
}: {
  pageId: AdminPageId;
  accountCreateOpen?: boolean;
  onCloseAccountCreate?: () => void;
}) {
  let content: ReactNode;
  switch (pageId) {
    case "accounts":
      return <AccountManagement createOpen={accountCreateOpen} onCloseCreate={onCloseAccountCreate} />;
    case "tokens":
      content = <TokenUsageMonitoring />;
      break;
    case "messages":
      content = <MessageAuditManagement />;
      break;
    case "agent-runtime":
      content = (
        <>
          <OAuthSettings />
          <AgentRuntimeConfig />
        </>
      );
      break;
    case "telegram":
      content = <TelegramAdminConfig />;
      break;
    case "updates":
      content = <AutoUpdateConfig />;
      break;
    case "security":
      content = <SecuritySettings />;
      break;
    case "runtime":
      content = <RuntimeSettings />;
      break;
    case "cognee":
      content = <CogneeInternalConfig />;
      break;
    case "secrets":
      content = <SecretsSettings />;
      break;
    default: {
      // Exhaustiveness guard: AdminPageId is a closed union.
      const _exhaustive: never = pageId;
      return _exhaustive;
    }
  }
  return <AdminPageSuspense>{content}</AdminPageSuspense>;
}
