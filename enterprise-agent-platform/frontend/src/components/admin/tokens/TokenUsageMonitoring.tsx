/* <TokenUsageMonitoring/> — the token-usage dashboard (legacy
   renderTokenUsageMonitoring, legacy-app.js:1559-1669): overview card with the
   days filter + refresh, 8 metric tiles, the 7-day SVG curve, and 4 usage tables
   (by account, detail, by scope, by model). */

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
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";
import { UsageMetricTile } from "../../common/UsageMetricTile";
import { TokenUsageCurve } from "./TokenUsageCurve";
import { UsageTable } from "./UsageTable";

const DAY_RANGES = [7, 30, 90, 365];

export function TokenUsageMonitoring() {
  const store = useStoreHandle();
  const report = useStore((state) => state.tokenUsage);
  const tokenUsageDays = useStore((state) => state.tokenUsageDays);
  const busy = useStore((state) => state.busy);
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
        <small>{row.username ? `@${row.username}` : `ID ${row.user_id || "-"}`}</small>
      </span>
    );
  };

  const tokenScopeLabel = (row: TokenDetailRow | TokenScopeRow): string => {
    if (row.scope_type === "private") {
      return `私聊：${row.scope_name || row.display_name || row.username || row.scope_id}`;
    }
    if (row.scope_type === "channel") {
      return row.scope_name || `频道 ${row.scope_id || ""}`;
    }
    return String(row.scope_name || row.scope_id || "-");
  };

  const tokenModelLabel = (row: TokenDetailRow | TokenModelRow): string => {
    const provider = oauthProviderLabel(row.provider || "", providers);
    const model = row.model || "unknown";
    return provider ? `${provider} / ${model}` : model;
  };

  return (
    <div className="token-usage">
      <section className="card token-usage__overview">
        <CardHead
          title="Token 消耗总览"
          icon="barChart"
          desc={
            report?.window
              ? `${formatTimestamp(report.window.since)} 至 ${formatTimestamp(report.window.until)}`
              : "暂无 token usage 数据"
          }
          extra={
            <div className="token-usage__filters">
              <Field label="时间范围">
                <select
                  value={daysValue}
                  onChange={(event) =>
                    void changeTokenUsageDays(store, Number(event.target.value) || 30)
                  }
                >
                  {DAY_RANGES.map((value) => (
                    <option key={value} value={value}>{`${value} 天`}</option>
                  ))}
                </select>
              </Field>
              <button
                className="btn btn--sm"
                type="button"
                disabled={busy}
                onClick={() => void refreshTokenUsage(store)}
              >
                <Icon name="refresh" size={14} />
                <span>刷新</span>
              </button>
            </div>
          }
        />
        <div className="metric-grid">
          <UsageMetricTile label="本日消耗" value={today.total_tokens ?? 0} />
          <UsageMetricTile label="近 7 日消耗" value={last7.total_tokens ?? 0} />
          <UsageMetricTile label="总 Token" value={summary.total_tokens ?? 0} />
          <UsageMetricTile label="输入 Token" value={summary.input_tokens ?? 0} />
          <UsageMetricTile label="输出 Token" value={summary.output_tokens ?? 0} />
          <UsageMetricTile label="Agent 调用" value={summary.event_count ?? 0} suffix="次" />
          <UsageMetricTile label="涉及账户" value={summary.account_count ?? 0} suffix="个" />
          <UsageMetricTile
            label="频道/私聊"
            value={`${summary.channel_event_count || 0}/${summary.private_event_count || 0}`}
            suffix="次"
          />
        </div>
        <TokenUsageCurve rows={dailyUsage} />
      </section>

      <UsageTable<TokenAccountRow>
        title="按账户汇总"
        desc="每个账户在当前时间范围内触发的 Agent token 消耗。"
        icon="users"
        headers={["账户", "调用", "输入", "输出", "总计", "最近使用"]}
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
        emptyText="暂无账户 token 数据。"
      />

      <UsageTable<TokenDetailRow>
        title="账户 / 渠道 / 模型明细"
        desc="细分到每个账户在私聊或具体频道中使用的供应商和模型。"
        icon="barChart"
        headers={["账户", "渠道", "供应商 / 模型", "调用", "输入", "输出", "总计"]}
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
        emptyText="暂无 token 明细。"
      />

      <div className="token-usage__columns">
        <UsageTable<TokenScopeRow>
          title="按渠道汇总"
          desc="区分私人 Agent 会话和具体频道。"
          icon="message"
          headers={["渠道", "调用", "输入", "输出", "总计"]}
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
          emptyText="暂无渠道汇总。"
        />
        <UsageTable<TokenModelRow>
          title="按供应商和模型汇总"
          desc="用于比较不同模型的 token 消耗。"
          icon="shield"
          headers={["供应商 / 模型", "调用", "输入", "输出", "总计"]}
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
          emptyText="暂无模型汇总。"
        />
      </div>
    </div>
  );
}
