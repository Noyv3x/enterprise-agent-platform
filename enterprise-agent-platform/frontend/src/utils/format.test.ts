import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLocale } from "../i18n";
import { formatCompactNumber, formatFileSize, formatNumber } from "./format";

afterEach(() => setCurrentLocale("zh-CN"));

describe("localized formatters", () => {
  it("formats numbers with the current UI locale", () => {
    setCurrentLocale("en");
    expect(formatNumber(1234567.89)).toBe(new Intl.NumberFormat("en").format(1234567.89));

    setCurrentLocale("zh-CN");
    expect(formatCompactNumber(12000)).toBe(
      new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(12000),
    );
  });

  it("localizes the numeric part of file sizes", () => {
    setCurrentLocale("en");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });
});
