/* <AdminPageContent pageId/> — the admin page dispatch table (legacy
   renderAdminPageSections, legacy-app.js:1410-1423). Maps each page id to its
   section component(s).

   Phase 4c owns accounts / tokens / messages; Phase 4d filled in the config,
   oauth and secrets pages below:
     model    → <OAuthSettings/> + <HermesConfig/>
     telegram → <TelegramAdminConfig/>
     updates  → <AutoUpdateConfig/>
     security → <SecuritySettings/>
     runtime  → <RuntimeSettings/>
     hermes   → <HermesInternalConfig/>
     cognee   → <CogneeInternalConfig/>
     secrets  → <SecretsSettings/> */

import type { AdminPageId } from "../../types";
import { AccountManagement } from "./accounts/AccountManagement";
import { MessageAuditManagement } from "./audit/MessageAuditManagement";
import { TokenUsageMonitoring } from "./tokens/TokenUsageMonitoring";
import { AutoUpdateConfig } from "./config/AutoUpdateConfig";
import { CogneeInternalConfig } from "./config/CogneeInternalConfig";
import { HermesConfig } from "./config/HermesConfig";
import { HermesInternalConfig } from "./config/HermesInternalConfig";
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
    case "model":
      return (
        <>
          <OAuthSettings />
          <HermesConfig />
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
    case "hermes":
      return <HermesInternalConfig />;
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
