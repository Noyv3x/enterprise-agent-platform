import { lazy, Suspense } from "react";
import type { AdminPageId } from "../../types";
import { useI18n } from "../../i18n";
import { LoadingState } from "../ui/fieldwork";

const AccountManagement = lazy(() => import("./accounts/AccountManagement").then((m) => ({ default: m.AccountManagement })));
const TokenUsageMonitoring = lazy(() => import("./tokens/TokenUsageMonitoring").then((m) => ({ default: m.TokenUsageMonitoring })));
const MessageAuditManagement = lazy(() => import("./audit/MessageAuditManagement").then((m) => ({ default: m.MessageAuditManagement })));
const AgentRuntimeConfig = lazy(() => import("./config/AgentRuntimeConfig").then((m) => ({ default: m.AgentRuntimeConfig })));
const OAuthSettings = lazy(() => import("./oauth/OAuthSettings").then((m) => ({ default: m.OAuthSettings })));
const TelegramAdminConfig = lazy(() => import("./config/TelegramAdminConfig").then((m) => ({ default: m.TelegramAdminConfig })));
const AutoUpdateConfig = lazy(() => import("./config/AutoUpdateConfig").then((m) => ({ default: m.AutoUpdateConfig })));
const BrandingSettings = lazy(() => import("./config/BrandingSettings").then((m) => ({ default: m.BrandingSettings })));
const SecuritySettings = lazy(() => import("./config/SecuritySettings").then((m) => ({ default: m.SecuritySettings })));
const RuntimeSettings = lazy(() => import("./config/RuntimeSettings").then((m) => ({ default: m.RuntimeSettings })));
const SecretsSettings = lazy(() => import("./secrets/SecretsSettings").then((m) => ({ default: m.SecretsSettings })));

export function AdminPageContent({ pageId, accountCreateOpen, onCloseAccountCreate }: { pageId: AdminPageId; accountCreateOpen: boolean; onCloseAccountCreate: () => void }) {
  const { t } = useI18n();
  const pages = {
    accounts: <AccountManagement createOpen={accountCreateOpen} onCloseCreate={onCloseAccountCreate} />,
    tokens: <TokenUsageMonitoring />, messages: <MessageAuditManagement />,
    "agent-runtime": <><AgentRuntimeConfig /><OAuthSettings /></>, telegram: <TelegramAdminConfig />,
    updates: <AutoUpdateConfig />, branding: <BrandingSettings />, security: <SecuritySettings />,
    runtime: <RuntimeSettings />, secrets: <SecretsSettings />,
  };
  return <Suspense fallback={<LoadingState label={t("common.loading")} />}>{pages[pageId]}</Suspense>;
}
