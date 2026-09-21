import { useState } from "react";
import { changeTokenUsageDays } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { TokenAccountRow, TokenDailyUsageRow, TokenDetailRow, TokenModelRow, TokenScopeRow } from "../../../types";
import { formatNumber, formatTimestamp } from "../../../utils/format";
import { oauthProviderLabel } from "../../../utils/oauth";
import { DataRegion, DataTable, EmptyState, FactGrid, Section, SegmentedControl, type DataColumn } from "../../ui/beautiful";

const DAY_RANGES = [7, 30, 90, 365];
type UsageCounts = Pick<TokenDailyUsageRow, "event_count" | "input_tokens" | "output_tokens" | "total_tokens">;

export function TokenUsageMonitoring() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const report = useStore((state) => state.tokenUsage);
  const days = useStore((state) => state.tokenUsageDays);
  const changingRange = useStore((state) => state.pendingOperations.includes("admin:tokens:range"));
  const refreshing = useStore((state) => state.pendingOperations.includes("admin:tokens:refresh"));
  const providers = useStore((state) => state.oauthProviders?.providers);
  const [group, setGroup] = useState("account");
  const unknown = t("admin.common.unknown");
  const number = (value: number | undefined) => value === undefined ? unknown : formatNumber(value);
  const timestamp = (value: number | string | null | undefined) => value == null || value === "" ? unknown : formatTimestamp(value) || String(value);
  const summary = report?.summary;
  const counts = <T extends UsageCounts,>(): DataColumn<T>[] => [
    { title: t("admin.tokens.header.calls"), key: "event_count", render: (row) => number(row.event_count) },
    { title: t("admin.tokens.header.input"), key: "input_tokens", render: (row) => number(row.input_tokens) },
    { title: t("admin.tokens.header.output"), key: "output_tokens", render: (row) => number(row.output_tokens) },
    { title: t("admin.tokens.header.total"), key: "total_tokens", render: (row) => number(row.total_tokens) },
  ];
  const account = (row: TokenAccountRow | TokenDetailRow) => <div className="admin-record-identity">
    <span>{row.display_name || row.username || unknown}</span>
    {row.username && <span className="bui-muted">@{row.username}</span>}
    {row.user_id !== undefined && <span className="bui-muted">{t("admin.tokens.userId", { id: row.user_id })}</span>}
  </div>;
  const scope = (row: TokenScopeRow | TokenDetailRow) => {
    const identity = row.scope_name || row.display_name || row.username || row.scope_id || unknown;
    const label = row.scope_type === "private" ? t("admin.tokens.privateScope", { name: identity })
      : row.scope_type === "channel" ? row.scope_name || t("admin.tokens.channelScope", { id: row.scope_id ?? unknown }) : String(identity);
    return <div className="admin-record-identity"><span>{label}</span>
      <span className="bui-muted">{row.scope_type || unknown}{row.scope_id !== undefined ? ` · ${row.scope_id}` : ""}</span>
      {row.display_name && row.display_name !== row.scope_name && <span>{row.display_name}</span>}
      {row.username && <span className="bui-muted">@{row.username}</span>}
    </div>;
  };
  const model = (row: TokenModelRow) => <div className="admin-record-identity">
    <span>{oauthProviderLabel(row.provider || "", providers) || unknown}</span>
    {row.provider && oauthProviderLabel(row.provider, providers) !== row.provider && <span className="bui-muted">{row.provider}</span>}
    <span className="bui-mono">{row.model || unknown}</span>
  </div>;
  const dailyColumns: DataColumn<TokenDailyUsageRow>[] = [
    { title: t("admin.tokens.daily.date"), key: "date", render: (row) => row.date || unknown },
    { title: t("admin.tokens.daily.label"), key: "label", render: (row) => row.label || unknown },
    { title: t("admin.tokens.daily.start"), key: "start_at", render: (row) => timestamp(row.start_at) },
    ...counts<TokenDailyUsageRow>(),
  ];
  const accountColumns: DataColumn<TokenAccountRow>[] = [
    { title: t("admin.tokens.header.account"), key: "account", render: account }, ...counts<TokenAccountRow>(),
    { title: t("admin.tokens.header.lastUsed"), key: "last_used_at", render: (row) => row.last_used_at == null || row.last_used_at === "" ? t("admin.audit.noRecord") : timestamp(row.last_used_at) },
  ];
  const scopeColumns: DataColumn<TokenScopeRow>[] = [{ title: t("admin.tokens.header.scope"), key: "scope", render: scope }, ...counts<TokenScopeRow>()];
  const modelColumns: DataColumn<TokenModelRow>[] = [{ title: t("admin.tokens.header.providerModel"), key: "model", render: model }, ...counts<TokenModelRow>()];
  const detailColumns: DataColumn<TokenDetailRow>[] = [
    { title: t("admin.tokens.header.account"), key: "account", render: account },
    { title: t("admin.tokens.header.scope"), key: "scope", render: scope },
    { title: t("admin.tokens.header.providerModel"), key: "model", render: model }, ...counts<TokenDetailRow>(),
  ];
  const table = <T extends object,>(rows: T[] | undefined, columns: DataColumn<T>[], title: string, empty: string, rowKey: (row: T) => string) => (
    <DataRegion state={rows?.length ? "ready" : "empty"} loadingLabel={t("admin.common.refresh")} empty={<EmptyState title={empty} compact />}>
      <DataTable aria-label={title} columns={columns} rows={rows || []} rowKey={rowKey} />
    </DataRegion>
  );
  const groups = [
    { value: "account", label: t("admin.tokens.byAccount.title"), children: <Section description={t("admin.tokens.byAccount.description")}>{table(report?.by_account, accountColumns, t("admin.tokens.byAccount.title"), t("admin.tokens.byAccount.empty"), (row) => String(row.user_id ?? row.username))}</Section> },
    { value: "scope", label: t("admin.tokens.byScope.title"), children: <Section description={t("admin.tokens.byScope.description")}>{table(report?.by_scope, scopeColumns, t("admin.tokens.byScope.title"), t("admin.tokens.byScope.empty"), (row) => `${row.scope_type}:${row.scope_id}`)}</Section> },
    { value: "model", label: t("admin.tokens.byModel.title"), children: <Section description={t("admin.tokens.byModel.description")}>{table(report?.by_model, modelColumns, t("admin.tokens.byModel.title"), t("admin.tokens.byModel.empty"), (row) => `${row.provider}:${row.model}`)}</Section> },
    { value: "details", label: t("admin.tokens.details.title"), children: <Section description={t("admin.tokens.details.description")}>{table(report?.details, detailColumns, t("admin.tokens.details.title"), t("admin.tokens.details.empty"), (row) => `${row.user_id}:${row.scope_type}:${row.scope_id}:${row.provider}:${row.model}`)}</Section> },
  ];
  return <Section>
    <Section>
      <div className="admin-usage-toolbar">
        {report?.window && <div className="admin-usage-period"><span>{t("admin.tokens.days", { count: report.window.days })}</span><span>{t("admin.tokens.range", { since: timestamp(report.window.since), until: timestamp(report.window.until) })}</span></div>}
        <SegmentedControl aria-label={t("admin.tokens.timeRange")} value={String(days || report?.window?.days || 30)} options={DAY_RANGES.map((count) => ({ value: String(count), label: t("admin.tokens.days", { count }), disabled: changingRange || refreshing }))} onChange={(value) => void changeTokenUsageDays(store, Number(value))} />
      </div>
      {report ? <FactGrid columns={4} items={[
        { key: "today", label: t("admin.tokens.today"), value: number(report.today?.total_tokens) },
        { key: "last7", label: t("admin.tokens.last7"), value: number(report.last_7_days?.total_tokens) },
        { key: "total", label: t("admin.tokens.total"), value: number(summary?.total_tokens) },
        { key: "input", label: t("admin.tokens.input"), value: number(summary?.input_tokens) },
        { key: "output", label: t("admin.tokens.output"), value: number(summary?.output_tokens) },
        { key: "calls", label: t("admin.tokens.agentCalls"), value: number(summary?.event_count) },
        { key: "accounts", label: t("admin.tokens.accountsInvolved"), value: number(summary?.account_count) },
        { key: "scopes", label: t("admin.tokens.channelPrivate"), value: `${number(summary?.channel_event_count)} / ${number(summary?.private_event_count)}` },
      ]} /> : <EmptyState title={t("admin.tokens.noUsage")} compact />}
    </Section>
    {report && <><Section title={t("admin.tokens.daily.title")}>{table(report.daily_usage, dailyColumns, t("admin.tokens.daily.title"), t("admin.tokens.noUsage"), (row) => String(row.date ?? row.start_at))}</Section>
      <SegmentedControl aria-label={t("admin.page.tokens.label")} options={groups} value={group} onChange={setGroup} />
      {groups.find((item) => item.value === group)?.children}
    </>}
  </Section>;
}
