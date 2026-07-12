/* =====================================================================
   Pure formatters — ported verbatim from legacy-app.js:2797-2849. Same
   rounding/locale behavior. No hooks, no store reads.
   ===================================================================== */

import { getCurrentLocale } from "../i18n";

export function initials(name: unknown): string {
  const s = String(name ?? "?").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && /[a-zA-Z]/.test(s)) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return s.slice(0, 2).toUpperCase();
}

/** Input is UNIX seconds. Same-day → HH:MM; otherwise M/D HH:MM. */
export function formatTime(value: number | null | undefined): string {
  if (!value) return "";
  const d = new Date(value * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const locale = getCurrentLocale();
  const hm = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${hm}`;
}

/** number → seconds; string → Date(string). Falls back to String(value). */
export function formatTimestamp(value: number | string | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(getCurrentLocale());
}

export function formatNumber(value: unknown): string {
  const number = Number(value) || 0;
  return new Intl.NumberFormat(getCurrentLocale()).format(number);
}

export function shortSha(value: unknown): string {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 7) : "-";
}

export function formatCompactNumber(value: unknown): string {
  const number = Number(value) || 0;
  return new Intl.NumberFormat(getCurrentLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
}

export function formatFileSize(value: unknown): string {
  let size = Math.max(0, Number(value) || 0);
  const locale = getCurrentLocale();
  const units = ["B", "KB", "MB", "GB"];
  for (const unit of units) {
    if (size < 1024 || unit === units[units.length - 1]) {
      const amount = new Intl.NumberFormat(locale, {
        minimumFractionDigits: unit === "B" ? 0 : 1,
        maximumFractionDigits: unit === "B" ? 0 : 1,
      }).format(unit === "B" ? Math.round(size) : size);
      return `${amount} ${unit}`;
    }
    size /= 1024;
  }
  return "0 B";
}

/** <input type="datetime-local"> value → UNIX seconds (or null if blank/invalid). */
export function unixFromDatetimeLocal(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}
