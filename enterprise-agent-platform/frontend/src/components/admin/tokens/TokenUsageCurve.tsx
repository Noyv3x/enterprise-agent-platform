/* <TokenUsageCurve/> — the 7-day token consumption SVG curve (legacy
   renderTokenUsageCurve, legacy-app.js:1680-1724). Geometry comes from
   utils/tokenCurve (640×170, padX 26, padY 18, x-step 98, baseline y 152),
   computed once per data change via useMemo. The SVG keeps the source aspect
   ratio so the trend is never visually distorted by a narrow container. */

import { useMemo } from "react";
import { formatCompactNumber, formatNumber } from "../../../utils/format";
import { tokenCurve } from "../../../utils/tokenCurve";
import type { TokenDailyUsageRow } from "../../../types";
import { useI18n } from "../../../i18n";

export function TokenUsageCurve({ rows }: { rows: TokenDailyUsageRow[] }) {
  const { locale, t } = useI18n();
  const curve = useMemo(() => tokenCurve(rows, locale), [rows, locale]);
  const { width, height, padX, padY, daily, points, linePath, areaPath, total } = curve;

  return (
    <div className="token-curve">
      <div className="token-curve__head">
        <div>
          <strong>{t("admin.tokens.curve.title")}</strong>
          <span>{t("admin.tokens.tokenCount", { count: formatNumber(total) })}</span>
        </div>
        <span className="muted">
          {daily.length ? `${daily[0].label} - ${daily[daily.length - 1].label}` : ""}
        </span>
      </div>
      <div
        className="token-curve__viewport"
        role="region"
        aria-label={t("admin.tokens.curve.ariaLabel")}
        tabIndex={0}
      >
        <div className="token-curve__plot">
          <svg
            className="token-curve__svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={t("admin.tokens.curve.ariaLabel")}
            preserveAspectRatio="xMidYMid meet"
          >
            <line
              className="token-curve__axis"
              x1={padX}
              y1={height - padY}
              x2={width - padX}
              y2={height - padY}
            />
            {areaPath ? <path className="token-curve__area" d={areaPath} /> : null}
            {linePath ? <path className="token-curve__line" d={linePath} /> : null}
            {points.map((point, index) => (
              <circle
                key={index}
                className="token-curve__point"
                cx={point.x.toFixed(1)}
                cy={point.y.toFixed(1)}
                r={4}
              >
                <title>{t("admin.tokens.curve.point", { date: point.label, count: formatNumber(point.total_tokens) })}</title>
              </circle>
            ))}
          </svg>
          <div className="token-curve__labels">
            {daily.map((row, index) => (
              <div className="token-curve__label" key={index}>
                <span>{row.label}</span>
                <strong>{formatCompactNumber(row.total_tokens)}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
