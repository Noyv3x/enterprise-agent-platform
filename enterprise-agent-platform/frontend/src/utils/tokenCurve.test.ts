import { describe, expect, it } from "vitest";
import { normalizeTokenDailyUsage, tokenCurve, tokenUsageDateLabel } from "./tokenCurve";

describe("localized token curve dates", () => {
  it("formats date-only values with the requested locale", () => {
    expect(tokenUsageDateLabel("2026-07-01", "en")).toBe(
      new Intl.DateTimeFormat("en", { month: "2-digit", day: "2-digit" }).format(new Date(2026, 6, 1)),
    );
    expect(tokenUsageDateLabel("2026-07-01", "zh-TW")).toBe(
      new Intl.DateTimeFormat("zh-TW", { month: "2-digit", day: "2-digit" }).format(new Date(2026, 6, 1)),
    );
  });

  it("does not reuse the backend display label after a locale change", () => {
    const rows = [{ date: "2026-07-01", label: "07/01", total_tokens: 12 }];
    const englishRows = normalizeTokenDailyUsage(rows, "en");
    const traditionalRows = tokenCurve(rows, "zh-TW").daily;
    const english = englishRows[englishRows.length - 1];
    const traditional = traditionalRows[traditionalRows.length - 1];
    expect(english?.label).toBe(tokenUsageDateLabel("2026-07-01", "en"));
    expect(traditional?.label).toBe(tokenUsageDateLabel("2026-07-01", "zh-TW"));
  });
});
