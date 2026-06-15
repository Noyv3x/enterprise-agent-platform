/* =====================================================================
   Token-usage 7-day curve geometry + normalization — ported from
   legacy-app.js:1680-1753 (renderTokenUsageCurve / normalizeTokenDailyUsage /
   tokenUsageDateLabel). Geometry is extracted so the curve can be redrawn in
   JSX later with identical coordinates.

   Viewport: 640×170, padX 26, padY 18 → with 7 points the x-step is 98 and the
   baseline sits at y=152 (height-padY).
   ===================================================================== */

import type { TokenDailyUsageRow } from "../types";

export const TOKEN_CURVE_GEOMETRY = {
  width: 640,
  height: 170,
  padX: 26,
  padY: 18,
} as const;

export interface NormalizedDailyUsage {
  date: string;
  label: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  event_count: number;
}

export interface TokenCurvePoint extends NormalizedDailyUsage {
  x: number;
  y: number;
}

export interface TokenCurve {
  width: number;
  height: number;
  padX: number;
  padY: number;
  daily: NormalizedDailyUsage[];
  points: TokenCurvePoint[];
  linePath: string;
  areaPath: string;
  total: number;
  maxTotal: number;
}

/** value → MM/DD (zero-padded). number is UNIX seconds. "-" if blank/invalid. */
export function tokenUsageDateLabel(value: number | string | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

/** Always returns exactly 7 rows (left-padded with empty placeholders) so the
 *  curve + label grid never change width. */
export function normalizeTokenDailyUsage(
  rows: readonly TokenDailyUsageRow[] | null | undefined,
): NormalizedDailyUsage[] {
  const items: NormalizedDailyUsage[] = (Array.isArray(rows) ? rows : []).slice(-7).map((row) => ({
    date: row.date || "",
    label: row.label || tokenUsageDateLabel(row.start_at ?? row.date),
    input_tokens: Number(row.input_tokens) || 0,
    output_tokens: Number(row.output_tokens) || 0,
    total_tokens: Number(row.total_tokens) || 0,
    event_count: Number(row.event_count) || 0,
  }));
  while (items.length < 7) {
    items.unshift({
      date: "",
      label: "-",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      event_count: 0,
    });
  }
  return items;
}

/** Compute the SVG path geometry for the 7-day token curve. */
export function tokenCurve(rows: readonly TokenDailyUsageRow[] | null | undefined): TokenCurve {
  const daily = normalizeTokenDailyUsage(rows);
  const maxTotal = Math.max(1, ...daily.map((row) => Number(row.total_tokens) || 0));
  const { width, height, padX, padY } = TOKEN_CURVE_GEOMETRY;
  const usableWidth = width - padX * 2;
  const usableHeight = height - padY * 2;
  const points: TokenCurvePoint[] = daily.map((row, index) => {
    const ratio = Math.max(0, (Number(row.total_tokens) || 0) / maxTotal);
    const x = padX + (daily.length <= 1 ? 0 : index * (usableWidth / (daily.length - 1)));
    const y = height - padY - ratio * usableHeight;
    return { ...row, x, y };
  });
  const linePath = points
    .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${height - padY} L ${points[0].x.toFixed(1)} ${height - padY} Z`
    : "";
  const total = daily.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);
  return { width, height, padX, padY, daily, points, linePath, areaPath, total, maxTotal };
}
