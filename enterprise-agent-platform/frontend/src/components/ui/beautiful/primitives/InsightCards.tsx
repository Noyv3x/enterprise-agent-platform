/* Adapted from Beautiful UI components/primitives/InsightCards.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adaptations: the three demo cards keep their markup but take real data — `CompareCard` (two plotted series
 * with headline values), `TrendCard` (the anomaly card: one line with a two-metric toggle) and
 * `AllocationCard` (segmented share bar); every number is formatted by the caller and every string is
 * translated by the caller; the tooltip can carry the bucket label; pages carry rendered cards; the follow-up
 * prompt pill is dropped (it sent demo prompts); a `Grid` variant lays the pages side by side for wide
 * windows, while `Pager` keeps the upstream carousel. */
import { Liveline, type LivelinePoint, type LivelineSeries } from "liveline";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import "./insight-cards.css";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/* anchor the snapshot to *call* time (inside each card's mount-time memo) —
 * a module-load constant goes stale, and once the points age past the chart
 * window the canvas renders empty */
function makePoints(values: number[], gap = 6): LivelinePoint[] {
  const end = Math.floor(Date.now() / 1000);
  return values.map((value, index) => ({
    time: end - (values.length - 1 - index) * gap,
    value,
  }));
}

/* Catmull-Rom resample — turn a sparse series into a dense, smoothly curved
 * one so both the line and the hover cursor glide instead of stepping between
 * a handful of points. */
function smooth(values: number[], perSegment = 9): number[] {
  if (values.length < 3) return values.slice();
  const out: number[] = [];
  const n = values.length;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = values[Math.max(0, i - 1)];
    const p1 = values[i];
    const p2 = values[i + 1];
    const p3 = values[Math.min(n - 1, i + 2)];
    for (let s = 0; s < perSegment; s += 1) {
      const t = s / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 *
          (2 * p1 +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3),
      );
    }
  }
  out.push(values[n - 1]);
  return out;
}

/* dense, smoothed points spanning exactly `spanSecs` — keeps the chart window
 * unchanged while multiplying the resolution. */
function smoothPoints(values: number[], spanSecs: number): LivelinePoint[] {
  const dense = smooth(values);
  return makePoints(dense, spanSecs / Math.max(1, dense.length - 1));
}

function useDarkMode() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

/* inline @entity mention */
export function InsightEntity({ name, tone }: { name: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-baseline font-medium text-ink">
      <span className={`inline-block size-2.5 rounded-full ${tone}`} />
      {name}
    </span>
  );
}

export function InsightMono({ children, tone }: { children: ReactNode; tone: "red" | "green" | "neutral" }) {
  return (
    <code className={`font-mono text-[11.5px] ${tone === "red" ? "text-red-ink" : tone === "green" ? "text-green-ink" : "text-ink-2"}`}>
      {children}
    </code>
  );
}

function chartIndexFromPointer(event: React.PointerEvent<HTMLDivElement>, pointCount: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  const progress = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return Math.round(progress * (pointCount - 1));
}

/* the bucket under a dense (smoothed) index */
function bucketAt(index: number, pointCount: number, bucketCount: number) {
  return Math.round((index / Math.max(1, pointCount - 1)) * (bucketCount - 1));
}

function ChartTooltip({ title, rows }: { title?: string; rows: { label: string; value: string; color: string }[] }) {
  return (
    <div className="insight-chart-tooltip">
      {title && <span className="insight-chart-tooltip-title">{title}</span>}
      {rows.map((row) => (
        <span key={row.label} className="insight-chart-tooltip-item">
          <span className="insight-chart-tooltip-dot" style={{ background: row.color }} />
          {row.value}
        </span>
      ))}
    </div>
  );
}

function ChartStage({ pointCount, children, tooltip, hoverIndex, setHoverIndex, label }: {
  pointCount: number;
  children: ReactNode;
  tooltip: (index: number) => ReactNode;
  hoverIndex: number | null;
  setHoverIndex: (index: number | null) => void;
  label: string;
}) {
  return (
    <div
      className="insight-chart-stage relative h-[166px]"
      role="img"
      aria-label={label}
      onPointerDown={(event) => setHoverIndex(chartIndexFromPointer(event, pointCount))}
      onPointerMove={(event) => setHoverIndex(chartIndexFromPointer(event, pointCount))}
      onPointerLeave={() => setHoverIndex(null)}
      onPointerCancel={() => setHoverIndex(null)}
      onPointerUp={() => setHoverIndex(null)}
    >
      {children}
      {hoverIndex !== null && <>
        <span className="insight-chart-cursor" style={{ left: `${(hoverIndex / (pointCount - 1)) * 100}%` }} />
        <span className="insight-chart-tooltip-anchor" style={{ left: `${Math.min(Math.max((hoverIndex / (pointCount - 1)) * 100, 28), 72)}%` }}>
          {tooltip(hoverIndex)}
        </span>
      </>}
    </div>
  );
}

/* content shape for the comparison card's plotted series */
export type CompareSeries = {
  name: string;
  values: number[];
  /** big headline under the legend */
  headline: string;
  sub: string;
  tone: "red" | "green" | "neutral";
  dot: string;
  /** canvas colour for the line */
  color: string;
  tooltipColor: string;
  format: (value: number) => string;
};

/* 1 — comparison: 2 series, legend + big values + line chart */
export function CompareCard({ series, caption, badge, bucketLabels, chartLabel }: {
  series: CompareSeries[];
  caption: string;
  badge: string;
  bucketLabels: string[];
  chartLabel: string;
}) {
  const dark = useDarkMode();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const points = useMemo(() => series.map((s) => smoothPoints(s.values, 42)), [series]);
  const pointCount = points[0]?.length ?? 0;

  const chartSeries: LivelineSeries[] = useMemo(
    () =>
      series.map((s, i) => ({
        id: s.name,
        label: "",
        data: points[i],
        value: points[i][points[i].length - 1]?.value ?? (s.values[s.values.length - 1] ?? 0),
        color: s.color,
      })),
    [series, points],
  );

  return (
    <div className="min-h-[278px] rounded-card bg-surface p-3 shadow-hairline">
      <div className="flex items-center gap-4">
        {series.map((s) => (
          <div key={s.name} className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
              <span className={`size-2 rounded-full ${s.dot}`} />
              {s.name}
            </span>
            <span className={`block text-[17px] font-semibold tracking-[-0.01em] tabular-nums ${s.tone === "red" ? "text-red-ink" : s.tone === "green" ? "text-green-ink" : "text-ink"}`}>
              {s.headline}
            </span>
            <InsightMono tone={s.tone}>{s.sub}</InsightMono>
          </div>
        ))}
      </div>
      <div className="mt-2 overflow-hidden rounded-control bg-inset shadow-hairline">
        <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
          <span className="text-[11px] text-ink-2 tabular-nums">
            {hoverIndex !== null && pointCount > 1 ? bucketLabels[bucketAt(hoverIndex, pointCount, bucketLabels.length)] : caption}
          </span>
          <span className="rounded-full bg-field px-2 py-0.5 text-[10.5px] font-medium text-ink-2">
            {badge}
          </span>
        </div>
        <ChartStage
          label={chartLabel}
          pointCount={pointCount}
          hoverIndex={pointCount > 1 ? hoverIndex : null}
          setHoverIndex={setHoverIndex}
          tooltip={(index) => (
            <ChartTooltip rows={series.map((s, i) => ({ label: s.name, value: s.format(points[i][index].value), color: s.tooltipColor }))} />
          )}
        >
          <Liveline
            data={[]}
            value={0}
            series={chartSeries}
            theme={dark ? "dark" : "light"}
            grid={false}
            pulse={false}
            window={42}
            paused
            scrub={false}
            cursor="default"
            lineWidth={2.25}
            padding={{ top: 40, right: 0, bottom: 22, left: 0 }}
            formatValue={series[0]?.format}
            /* the snapshot's times are synthetic; the axis reads the caller's period labels */
            formatTime={(time) => {
              const start = points[0]?.[0]?.time ?? time;
              return bucketLabels[Math.round(((time - start) / 42) * (bucketLabels.length - 1))] ?? "";
            }}
          />
        </ChartStage>
      </div>
    </div>
  );
}

/* content shape for one of the trend card's toggled metrics */
export type TrendMetric = {
  key: string;
  label: string;
  values: number[];
  format: (value: number) => string;
  /** shown in the chart header when nothing is hovered */
  caption: string;
};

/* 2 — trend (upstream anomaly card): one line with a metric toggle + big value */
export function TrendCard({ title, badge, metrics, headline, delta, deltaTone, period, bucketLabels, chartLabel, color = "#ee5c61", tooltipColor = "var(--red)" }: {
  title: string;
  badge: string;
  metrics: TrendMetric[];
  headline: string;
  delta?: string;
  deltaTone?: "red" | "green" | "neutral";
  period: string;
  bucketLabels: string[];
  chartLabel: string;
  color?: string;
  tooltipColor?: string;
}) {
  const dark = useDarkMode();
  const [metricKey, setMetricKey] = useState(metrics[0].key);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const metric = metrics.find((item) => item.key === metricKey) ?? metrics[0];
  const data = useMemo(() => makePoints(metric.values, 7), [metric]);
  const value = data[data.length - 1]?.value ?? 0;
  const hovered = hoverIndex !== null && data.length > 1 ? hoverIndex : null;

  return (
    <div className="min-h-[278px] rounded-card bg-surface p-3 shadow-hairline">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={tooltipColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          {title}
        </span>
        <span className="rounded-full bg-field px-2 py-0.5 text-[10.5px] font-medium text-ink-2">
          {badge}
        </span>
      </div>
      <div className="mt-2 overflow-hidden rounded-control bg-inset shadow-hairline">
        <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
          <span className="min-w-0 truncate text-[11px] text-ink-2 tabular-nums">
            {hovered !== null
              ? `${bucketLabels[hovered] ?? ""} · ${metric.format(data[hovered].value)}`
              : metric.caption}
          </span>
          {metrics.length > 1 && (
            <span className="flex shrink-0 rounded-full bg-field p-0.5" role="group" aria-label={title}>
              {metrics.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={metric.key === item.key}
                  onClick={() => setMetricKey(item.key)}
                  className={`insight-toggle rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.96] ${
                    metric.key === item.key ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:text-ink-2"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </span>
          )}
        </div>
        <ChartStage
          label={chartLabel}
          pointCount={data.length}
          hoverIndex={hovered}
          setHoverIndex={setHoverIndex}
          tooltip={(index) => (
            <ChartTooltip rows={[{ label: metric.label, value: metric.format(data[index].value), color: tooltipColor }]} />
          )}
        >
          <Liveline
            data={data}
            value={value}
            theme={dark ? "dark" : "light"}
            color={color}
            grid
            scrub={false}
            fill={false}
            pulse={false}
            momentum={false}
            paused
            window={Math.max(7, (data.length - 1) * 7)}
            lineWidth={2.25}
            cursor="crosshair"
            padding={{ top: 34, right: 0, bottom: 22, left: 0 }}
            formatValue={metric.format}
            formatTime={(time) => bucketLabels[Math.round((time - (data[0]?.time ?? time)) / 7)] ?? ""}
          />
        </ChartStage>
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[17px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
          {headline}
        </span>
        {delta && <InsightMono tone={deltaTone ?? "neutral"}>{delta}</InsightMono>}
        <span className="text-[11px] text-ink-2">{period}</span>
      </div>
    </div>
  );
}

/* content shape for one allocation segment */
export type AllocationSegment = {
  name: string;
  label: string;
  pct: number;
  amount: string;
  cls: string;
  tone: string;
  note: string;
};

/* 3 — allocation: hero number + segmented bar + legend */
export function AllocationCard({ title, segments, monogram, groupLabel }: {
  title: string;
  segments: AllocationSegment[];
  monogram?: string;
  groupLabel: string;
}) {
  const [selected, setSelected] = useState(segments[0]?.name);
  const active = segments.find((segment) => segment.name === selected) ?? segments[0];
  if (!active) return null;

  return (
    <div className="min-h-[278px] rounded-card bg-surface p-3 shadow-hairline">
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
        <span className={`flex size-3.5 items-center justify-center rounded-full text-[8px] font-bold text-white ${active.cls}`} aria-hidden>
          {monogram ?? active.label.slice(0, 1).toUpperCase()}
        </span>
        {title}
      </span>
      <span className="mt-1 block text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
        {active.amount}
      </span>
      <div
        className="mt-3 flex h-9 gap-0.5 overflow-hidden rounded-full bg-field p-0.5"
        role="group"
        aria-label={groupLabel}
      >
        {segments.map((s) => (
          <button
            key={s.name}
            type="button"
            aria-pressed={selected === s.name}
            aria-label={`${s.label}: ${s.pct}%`}
            onClick={() => setSelected(s.name)}
            className={`relative h-full min-w-1.5 overflow-hidden rounded-full ${s.cls} transition-[opacity,transform,box-shadow] duration-300 active:scale-[0.98]`}
            style={{
              width: `${s.pct}%`,
              opacity: selected === s.name ? 1 : 0.58,
              boxShadow: selected === s.name ? "inset 0 0 0 1px rgba(255,255,255,0.22)" : undefined,
              transitionTimingFunction: EASE,
            }}
          >
            <span
              className="absolute inset-y-1 left-1 rounded-full bg-white/20 transition-[width,opacity] duration-500"
              style={{
                width: selected === s.name ? "calc(100% - 8px)" : "0%",
                opacity: selected === s.name ? 1 : 0,
                transitionTimingFunction: EASE,
              }}
            />
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {segments.map((s) => (
          <button
            key={s.name}
            type="button"
            aria-pressed={selected === s.name}
            onClick={() => setSelected(s.name)}
            className={`insight-toggle flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] transition-[background-color,color,transform] duration-150 active:scale-[0.96] ${
              selected === s.name ? "bg-field text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
            }`}
          >
            <span className={`size-1.5 shrink-0 rounded-full ${s.cls}`} />
            <span className="truncate">{s.name}</span> <span className="tabular-nums">{s.pct}%</span>
          </button>
        ))}
      </div>
      <div className="mt-3 min-h-16 rounded-control bg-inset px-2.5 py-2 shadow-hairline">
        <span className={`block text-[11.5px] font-medium ${active.tone}`}>{active.label}</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-ink-2">
          {active.note}
        </span>
      </div>
    </div>
  );
}

/* content shape for one insight page */
export type InsightPage = {
  key: string;
  prose: ReactNode;
  card: ReactNode;
};

export type InsightCardsLabels = {
  /** carousel heading shown before the page count */
  title: string;
  previous: string;
  next: string;
};

export default function InsightCards({
  pages,
  labels,
  variant = "Pager",
}: {
  variant?: "Pager" | "Grid";
  pages: InsightPage[];
  labels: InsightCardsLabels;
}) {
  const [page, setPage] = useState(0);

  const move = (direction: -1 | 1) => {
    setPage((current) => (current + direction + pages.length) % pages.length);
  };

  if (variant === "Grid") {
    return (
      <section aria-label={labels.title} className="w-full">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold text-ink">{labels.title}</span>
          <span className="text-[13px] text-ink-2 tabular-nums">{pages.length}</span>
        </span>
        <div className="insight-grid mt-1.5">
          {pages.map(({ key, prose, card }) => (
            <div key={key} className="flex min-w-0 flex-col">
              <p className="min-h-[2lh] text-[12.5px] leading-relaxed text-ink-2">{prose}</p>
              <div className="mt-2">{card}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const current = pages[Math.min(page, pages.length - 1)];

  return (
    <section aria-label={labels.title} className="min-h-[360px] w-full max-w-86">
      {/* pager header */}
      <div className="flex items-center justify-between">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold text-ink">{labels.title}</span>
          <span className="text-[13px] text-ink-2 tabular-nums">{page + 1}/{pages.length}</span>
        </span>
        <span className="flex items-center gap-0.5">
          {(["M15 18l-6-6 6-6", "M9 6l6 6-6 6"] as const).map((d, i) => (
            <button
              key={i}
              type="button"
              aria-label={i === 0 ? labels.previous : labels.next}
              onClick={() => move(i === 0 ? -1 : 1)}
              className="insight-toggle flex size-6 items-center justify-center rounded-[6px] text-ink-2
                transition-[background-color,color,transform] duration-100 hover:bg-hover
                hover:text-ink active:scale-[0.96]"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={d} />
              </svg>
            </button>
          ))}
        </span>
      </div>

      {/* page content — blurred crossfade */}
      <div
        key={current.key}
        className="transition-[opacity,filter] duration-250"
        style={{ opacity: 1, filter: "blur(0)", animation: "fade-in 250ms ease-out both" }}
        aria-live="polite"
      >
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{current.prose}</p>
        <div className="mt-2">{current.card}</div>
      </div>
    </section>
  );
}
