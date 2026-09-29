import { beforeEach, describe, expect, it } from "vitest";
import { setCurrentLocale, t } from "../../i18n";
import { scheduleRuleLabel } from "./scheduleFormat";

describe("schedule formatting", () => {
  beforeEach(() => setCurrentLocale("en"));

  it("formats interval units without asking the browser to calculate next runs", () => {
    expect(scheduleRuleLabel({ type: "interval", every_seconds: 120 }, "UTC", "en", t)).toBe("Every 2 minutes");
    expect(scheduleRuleLabel({ type: "interval", every_seconds: 86_400 }, "UTC", "en", t)).toBe("Every 1 day");
  });
});
