import { Segmented, Space, Table, Tabs } from "antd";
import type { ColumnsType } from "antd/es/table";
import { changeTokenUsageDays } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { TokenAccountRow, TokenDailyUsageRow, TokenDetailRow, TokenModelRow, TokenScopeRow } from "../../../types";
import { formatNumber, formatTimestamp } from "../../../utils/format";
import { oauthProviderLabel } from "../../../utils/oauth";
import { DataRegion, EmptyState, FactGrid, Section } from "../../ui/fieldwork";

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
  const unknown = t("admin.common.unknown");
  const number = (value: number | undefined) => value === undefined ? unknown : formatNumber(value);
  const timestamp = (value: number | string | undefined) => value === undefined ? unknown : formatTimestamp(value) || String(value);
  const summary = report?.summary;
  const counts = <T extends UsageCounts,>(): ColumnsType<T> => [
    { title: t("admin.tokens.header.calls"), key: "event_count", align: "right", render: (_, row) => number(row.event_count) },
    { title: t("admin.tokens.header.input"), key: "input_tokens", align: "right", render: (_, row) => number(row.input_tokens) },
    { title: t("admin.tokens.header.output"), key: "output_tokens", align: "right", render: (_, row) => number(row.output_tokens) },
    { title: t("admin.tokens.header.total"), key: "total_tokens", align: "right", render: (_, row) => number(row.total_tokens) },
  ];
  const account = (row: TokenAccountRow | TokenDetailRow) => (
    <Space direction="vertical" size={0}>
      <span>{row.display_name || row.username || unknown}</span>
      {row.username && <span>@{row.username}</span>}
      {row.user_id !== undefined && <span>{t("admin.tokens.userId", { id: row.user_id })}</span>}
    </Space>
  );
  const scope = (row: TokenScopeRow | TokenDetailRow) => {
    const identity = row.scope_name || row.display_name || row.username || row.scope_id || unknown;
    const label = row.scope_type === "private"
      ? t("admin.tokens.privateScope", { name: identity })
      : row.scope_type === "channel"
        ? row.scope_name || t("admin.tokens.channelScope", { id: row.scope_id ?? unknown })
        : String(identity);
    return <Space direction="vertical" size={0}>
      <span>{label}</span>
      <span>{row.scope_type || unknown}{row.scope_id !== undefined ? ` · ${row.scope_id}` : ""}</span>
      {row.display_name && row.display_name !== row.scope_name && <span>{row.display_name}</span>}
      {row.username && <span>@{row.username}</span>}
    </Space>;
  };
  const model = (row: TokenModelRow) => <Space direction="vertical" size={0}>
    <span>{oauthProviderLabel(row.provider || "", providers) || unknown}</span>
    {row.provider && oauthProviderLabel(row.provider, providers) !== row.provider && <span>{row.provider}</span>}
    <span>{row.model || unknown}</span>
  </Space>;
  const dailyColumns: ColumnsType<TokenDailyUsageRow> = [
    { title: t("admin.tokens.daily.date"), dataIndex: "date", render: (value: string | undefined) => value || unknown },
    { title: t("admin.tokens.daily.label"), dataIndex: "label", render: (value: string | undefined) => value || unknown },
    { title: t("admin.tokens.daily.start"), dataIndex: "start_at", render: timestamp },
    ...counts<TokenDailyUsageRow>(),
  ];
  const accountColumns: ColumnsType<TokenAccountRow> = [
    { title: t("admin.tokens.header.account"), key: "account", render: (_, row) => account(row) },
    ...counts<TokenAccountRow>(),
    { title: t("admin.tokens.header.lastUsed"), dataIndex: "last_used_at", render: timestamp },
  ];
  const scopeColumns: ColumnsType<TokenScopeRow> = [
    { title: t("admin.tokens.header.scope"), key: "scope", render: (_, row) => scope(row) },
    ...counts<TokenScopeRow>(),
  ];
  const modelColumns: ColumnsType<TokenModelRow> = [
    { title: t("admin.tokens.header.providerModel"), key: "model", render: (_, row) => model(row) },
    ...counts<TokenModelRow>(),
  ];
  const detailColumns: ColumnsType<TokenDetailRow> = [
    { title: t("admin.tokens.header.account"), key: "account", render: (_, row) => account(row) },
    { title: t("admin.tokens.header.scope"), key: "scope", render: (_, row) => scope(row) },
    { title: t("admin.tokens.header.providerModel"), key: "model", render: (_, row) => model(row) },
    ...counts<TokenDetailRow>(),
  ];
  const table = <T extends object,>(rows: T[] | undefined, columns: ColumnsType<T>, title: string, empty: string) => (
    <DataRegion state={rows?.length ? "ready" : "empty"} loadingLabel={t("admin.common.refresh")} empty={<EmptyState title={empty} compact />}>
      <Table<T> aria-label={title} columns={columns} dataSource={rows} rowKey={(_, index) => String(index)} pagination={false} scroll={{ x: "max-content" }} />
    </DataRegion>
  );
  const groups = [
    { key: "account", label: t("admin.tokens.byAccount.title"), children: <Section description={t("admin.tokens.byAccount.description")}>{table(report?.by_account, accountColumns, t("admin.tokens.byAccount.title"), t("admin.tokens.byAccount.empty"))}</Section> },
    { key: "scope", label: t("admin.tokens.byScope.title"), children: <Section description={t("admin.tokens.byScope.description")}>{table(report?.by_scope, scopeColumns, t("admin.tokens.byScope.title"), t("admin.tokens.byScope.empty"))}</Section> },
    { key: "model", label: t("admin.tokens.byModel.title"), children: <Section description={t("admin.tokens.byModel.description")}>{table(report?.by_model, modelColumns, t("admin.tokens.byModel.title"), t("admin.tokens.byModel.empty"))}</Section> },
    { key: "details", label: t("admin.tokens.details.title"), children: <Section description={t("admin.tokens.details.description")}>{table(report?.details, detailColumns, t("admin.tokens.details.title"), t("admin.tokens.details.empty"))}</Section> },
  ];
  return <Section>
    <Section actions={<Space wrap>
      <Segmented aria-label={t("admin.tokens.timeRange")} value={days || report?.window?.days || 30} options={DAY_RANGES.map((count) => ({ value: count, label: t("admin.tokens.days", { count }) }))} disabled={changingRange || refreshing} onChange={(value) => void changeTokenUsageDays(store, Number(value))} />
    </Space>} description={report?.window ? <Space wrap>
      <span>{t("admin.tokens.days", { count: report.window.days })}</span>
      <span>{t("admin.tokens.range", { since: timestamp(report.window.since), until: timestamp(report.window.until) })}</span>
    </Space> : undefined}>
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
    {report && <>
      <Section title={t("admin.tokens.daily.title")}>
        {table(report.daily_usage, dailyColumns, t("admin.tokens.daily.title"), t("admin.tokens.noUsage"))}
      </Section>
      <Tabs items={groups} />
    </>}
  </Section>;
}
