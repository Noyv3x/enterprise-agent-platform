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

import type { AdminPageId } from "../../types";
import { AccountManagement } from "./accounts/AccountManagement";
import { MessageAuditManagement } from "./audit/MessageAuditManagement";
import { TokenUsageMonitoring } from "./tokens/TokenUsageMonitoring";
import { AutoUpdateConfig } from "./config/AutoUpdateConfig";
import { CogneeInternalConfig } from "./config/CogneeInternalConfig";
import { AgentRuntimeConfig } from "./config/AgentRuntimeConfig";
import { RuntimeSettings } from "./config/RuntimeSettings";
import { SecuritySettings } from "./config/SecuritySettings";
import { TelegramAdminConfig } from "./config/TelegramAdminConfig";
import { OAuthSettings } from "./oauth/OAuthSettings";
import { SecretsSettings } from "./secrets/SecretsSettings";

export function AdminPageContent({ pageId }: { pageId: AdminPageId }) {
  switch (pageId) {
    case "accounts":
      return <AccountManagement />;
    case "tokens":
      return <TokenUsageMonitoring />;
    case "messages":
      return <MessageAuditManagement />;
    case "agent-runtime":
      return (
        <>
          <OAuthSettings />
          <AgentRuntimeConfig />
        </>
      );
    case "telegram":
      return <TelegramAdminConfig />;
    case "updates":
      return <AutoUpdateConfig />;
    case "security":
      return <SecuritySettings />;
    case "runtime":
      return <RuntimeSettings />;
    case "cognee":
      return <CogneeInternalConfig />;
    case "secrets":
      return <SecretsSettings />;
    default: {
      // Exhaustiveness guard: AdminPageId is a closed union.
      const _exhaustive: never = pageId;
      return _exhaustive;
    }
  }
}
