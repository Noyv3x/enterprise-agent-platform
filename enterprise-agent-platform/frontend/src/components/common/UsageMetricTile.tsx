/* <UsageMetricTile/> — port of legacy usageMetric(label, value, suffix)
   (legacy-app.js:1671-1678). Shared by token-usage monitoring and the
   auto-update status grid. String values render verbatim; numeric values run
   through formatNumber. */

import { formatNumber } from "../../utils/format";

export interface UsageMetricTileProps {
  label: string;
  value: string | number;
  suffix?: string;
}

export function UsageMetricTile({ label, value, suffix = "" }: UsageMetricTileProps) {
  const isText = typeof value === "string";
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <strong>{isText ? value : formatNumber(value)}</strong>
      {suffix ? <small>{suffix}</small> : null}
    </div>
  );
}
