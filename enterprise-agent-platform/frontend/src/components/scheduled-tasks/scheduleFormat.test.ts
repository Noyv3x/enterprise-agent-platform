import { beforeEach, describe, expect, it } from "vitest";
import { setCurrentLocale, t } from "../../i18n";
import { formatScheduleDate, scheduleRuleLabel, scheduleRunStatusLabel } from "./scheduleFormat";

describe("schedule formatting", () => {
  beforeEach(() => setCurrentLocale("en"));

  it("formats interval units without asking the browser to calculate next runs", () => {
    expect(scheduleRuleLabel({ type: "interval", every_seconds: 120 }, "UTC", "en", t)).toBe("Every 2 minutes");
    expect(scheduleRuleLabel({ type: "interval", every_seconds: 86_400 }, "UTC", "en", t)).toBe("Every 1 day");
  });

  it("falls back safely when a stored time zone is invalid", () => {
    expect(formatScheduleDate("2026-07-16T09:00:00Z", "en", "Not/AZone")).not.toBe("");
  });

  it("labels non-interactive scheduled-run safety states", () => {
    expect(scheduleRunStatusLabel("blocked", t)).toBe("Blocked");
    expect(scheduleRunStatusLabel("needs_review", t)).toBe("Needs review");
  });
});
