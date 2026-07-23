/* <TokenUsageMonitoring/> — the token-usage dashboard (legacy
   renderTokenUsageMonitoring, legacy-app.js:1559-1669): overview card with the
   days filter + refresh, 8 metric tiles, the 7-day SVG curve, and 4 usage tables
   (by account, detail, by scope, by model). */

import { Button, Form, Select } from "antd";
import { changeTokenUsageDays, refreshTokenUsage } from "../../../data/adminActions";
import { formatNumber, formatTimestamp } from "../../../utils/format";
import { oauthProviderLabel } from "../../../utils/oauth";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type {
  TokenAccountRow,
  TokenDetailRow,
  TokenModelRow,
  TokenScopeRow,
} from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { UsageMetricTile } from "../../common/UsageMetricTile";
import { AdminCard } from "../AdminCard";
import { TokenUsageCurve } from "./TokenUsageCurve";
import { UsageTable } from "./UsageTable";
import { useI18n } from "../../../i18n";

const DAY_RANGES = [7, 30, 90, 365];

export function TokenUsageMonitoring() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const report = useStore((state) => state.tokenUsage);
  const tokenUsageDays = useStore((state) => state.tokenUsageDays);
  const changingRange = useStore((state) =>
    state.pendingOperations.includes("admin:tokens:range"),
  );
  const refreshing = useStore((state) =>
    state.pendingOperations.includes("admin:tokens:refresh"),
  );
  const oauthProviders = useStore((state) => state.oauthProviders);

  const summary = report?.summary || {};
  const today = report?.today || {};
  const last7 = report?.last_7_days || {};
  const dailyUsage = Array.isArray(report?.daily_usage) ? report.daily_usage : [];
  const accountRows = report?.by_account || [];
  const detailRows = report?.details || [];
  const scopeRows = report?.by_scope || [];
  const modelRows = report?.by_model || [];
  const providers = oauthProviders?.providers;

  const daysValue = String(tokenUsageDays || report?.window?.days || 30);

  const userUsageCell = (row: TokenAccountRow | TokenDetailRow) => {
    const name = row.display_name || row.username || `u${row.user_id || ""}`;
    return (
      <span className="usage-user">
        <strong>{name}</strong>
        <small>{row.username ? `@${row.username}` : t("admin.tokens.userId", { id: row.user_id || "-" })}</small>
      </span>
    );
  };

  const tokenScopeLabel = (row: TokenDetailRow | TokenScopeRow): string => {
    if (row.scope_type === "private") {
      return t("admin.tokens.privateScope", { name: row.scope_name || row.display_name || row.username || row.scope_id || "-" });
    }
    if (row.scope_type === "channel") {
      return row.scope_name || t("admin.tokens.channelScope", { id: row.scope_id || "-" });
    }
    return String(row.scope_name || row.scope_id || "-");
  };

  const tokenModelLabel = (row: TokenDetailRow | TokenModelRow): string => {
    const providerId = row.provider || "";
    const provider = providerId === "openai-codex" ? t("admin.oauth.provider.codex") : providerId === "xai-oauth" ? t("admin.oauth.provider.grok") : oauthProviderLabel(providerId, providers);
    const model = row.model || t("admin.common.unknown");
    return provider ? `${provider} / ${model}` : model;
  };

  return (
    <div className="token-usage">
      <AdminCard className="token-usage__overview">
        <CardHead
          title={t("admin.tokens.overview.title")}
          icon="barChart"
          desc={
            report?.window
              ? t("admin.tokens.range", { since: formatTimestamp(report.window.since), until: formatTimestamp(report.window.until) })
              : t("admin.tokens.noUsage")
          }
          extra={
            <div className="token-usage__filters">
              <Form.Item
                className="eap-field"
                label={t("admin.tokens.timeRange")}
                htmlFor="token-usage-days"
                style={{ marginBottom: 0 }}
              >
                <Select
                  id="token-usage-days"
                  value={daysValue}
                  disabled={changingRange}
                  loading={changingRange}
                  aria-busy={changingRange || undefined}
                  options={DAY_RANGES.map((value) => ({
                    value: String(value),
                    label: t("admin.tokens.days", { count: value }),
                  }))}
                  onChange={(value) =>
                    void changeTokenUsageDays(store, Number(value) || 30)
                  }
                />
              </Form.Item>
              <Button
                htmlType="button"
                size="small"
                loading={refreshing}
                aria-label={t(refreshing ? "resource.refreshing" : "admin.common.refresh")}
                onClick={() => void refreshTokenUsage(store)}
                icon={<Icon name="refresh" size={14} />}
              >
                {t("admin.common.refresh")}
              </Button>
            </div>
          }
        />
        <div className="metric-grid">
          <UsageMetricTile label={t("admin.tokens.today")} value={today.total_tokens ?? 0} />
          <UsageMetricTile label={t("admin.tokens.last7")} value={last7.total_tokens ?? 0} />
          <UsageMetricTile label={t("admin.tokens.total")} value={summary.total_tokens ?? 0} />
          <UsageMetricTile label={t("admin.tokens.input")} value={summary.input_tokens ?? 0} />
          <UsageMetricTile label={t("admin.tokens.output")} value={summary.output_tokens ?? 0} />
          <UsageMetricTile label={t("admin.tokens.agentCalls")} value={summary.event_count ?? 0} suffix={t("admin.tokens.callsSuffix", { count: summary.event_count ?? 0 })} />
          <UsageMetricTile label={t("admin.tokens.accountsInvolved")} value={summary.account_count ?? 0} suffix={t("admin.tokens.accountsSuffix", { count: summary.account_count ?? 0 })} />
          <UsageMetricTile
            label={t("admin.tokens.channelPrivate")}
            value={`${summary.channel_event_count || 0}/${summary.private_event_count || 0}`}
            suffix={t("admin.tokens.callsSuffix", { count: (summary.channel_event_count || 0) + (summary.private_event_count || 0) })}
          />
        </div>
        <TokenUsageCurve rows={dailyUsage} />
      </AdminCard>

      <UsageTable<TokenAccountRow>
        title={t("admin.tokens.byAccount.title")}
        desc={t("admin.tokens.byAccount.description")}
        icon="users"
        headers={[t("admin.tokens.header.account"), t("admin.tokens.header.calls"), t("admin.tokens.header.input"), t("admin.tokens.header.output"), t("admin.tokens.header.total"), t("admin.tokens.header.lastUsed")]}
        rows={accountRows}
        renderRow={(row) => (
          <>
            {userUsageCell(row)}
            <span>{formatNumber(row.event_count)}</span>
            <span>{formatNumber(row.input_tokens)}</span>
            <span>{formatNumber(row.output_tokens)}</span>
            <strong>{formatNumber(row.total_tokens)}</strong>
            <span>{formatTimestamp(row.last_used_at) || "-"}</span>
          </>
        )}
        emptyText={t("admin.tokens.byAccount.empty")}
      />

      <UsageTable<TokenDetailRow>
        title={t("admin.tokens.details.title")}
        desc={t("admin.tokens.details.description")}
        icon="barChart"
        headers={[t("admin.tokens.header.account"), t("admin.tokens.header.scope"), t("admin.tokens.header.providerModel"), t("admin.tokens.header.calls"), t("admin.tokens.header.input"), t("admin.tokens.header.output"), t("admin.tokens.header.total")]}
        rows={detailRows}
        renderRow={(row) => (
          <>
            {userUsageCell(row)}
            <span>{tokenScopeLabel(row)}</span>
            <span>{tokenModelLabel(row)}</span>
            <span>{formatNumber(row.event_count)}</span>
            <span>{formatNumber(row.input_tokens)}</span>
            <span>{formatNumber(row.output_tokens)}</span>
            <strong>{formatNumber(row.total_tokens)}</strong>
          </>
        )}
        emptyText={t("admin.tokens.details.empty")}
      />

      <div className="token-usage__columns">
        <UsageTable<TokenScopeRow>
          title={t("admin.tokens.byScope.title")}
          desc={t("admin.tokens.byScope.description")}
          icon="message"
          headers={[t("admin.tokens.header.scope"), t("admin.tokens.header.calls"), t("admin.tokens.header.input"), t("admin.tokens.header.output"), t("admin.tokens.header.total")]}
          rows={scopeRows}
          renderRow={(row) => (
            <>
              <span>{tokenScopeLabel(row)}</span>
              <span>{formatNumber(row.event_count)}</span>
              <span>{formatNumber(row.input_tokens)}</span>
              <span>{formatNumber(row.output_tokens)}</span>
              <strong>{formatNumber(row.total_tokens)}</strong>
            </>
          )}
          emptyText={t("admin.tokens.byScope.empty")}
        />
        <UsageTable<TokenModelRow>
          title={t("admin.tokens.byModel.title")}
          desc={t("admin.tokens.byModel.description")}
          icon="shield"
          headers={[t("admin.tokens.header.providerModel"), t("admin.tokens.header.calls"), t("admin.tokens.header.input"), t("admin.tokens.header.output"), t("admin.tokens.header.total")]}
          rows={modelRows}
          renderRow={(row) => (
            <>
              <span>{tokenModelLabel(row)}</span>
              <span>{formatNumber(row.event_count)}</span>
              <span>{formatNumber(row.input_tokens)}</span>
              <span>{formatNumber(row.output_tokens)}</span>
              <strong>{formatNumber(row.total_tokens)}</strong>
            </>
          )}
          emptyText={t("admin.tokens.byModel.empty")}
        />
      </div>
    </div>
  );
}
