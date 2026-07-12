import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLocale } from "../i18n";
import {
  telegramChallengeRelativeLabel,
  telegramChallengeTiming,
  telegramLinkView,
} from "./telegramLink";

afterEach(() => setCurrentLocale("zh-CN"));

describe("Telegram link challenge timing", () => {
  it("reports a live challenge using rounded-up minutes", () => {
    const timing = telegramChallengeTiming(1_300, 1_000);
    expect(timing).toEqual({
      valid: true,
      expired: false,
      secondsRemaining: 300,
      minutesRemaining: 5,
    });
    expect(telegramChallengeRelativeLabel(timing)).toBe("约 5 分钟后过期");
  });

  it("reports expiry without a negative countdown", () => {
    const timing = telegramChallengeTiming(999, 1_000);
    expect(timing.expired).toBe(true);
    expect(timing.secondsRemaining).toBe(0);
    expect(telegramChallengeRelativeLabel(timing)).toBe("绑定码已过期");
  });

  it("handles a missing server expiry", () => {
    const timing = telegramChallengeTiming(undefined, 1_000);
    expect(timing.valid).toBe(false);
    expect(telegramChallengeRelativeLabel(timing)).toBe("有效期未知");
  });

  it("uses English singular and plural countdown labels", () => {
    setCurrentLocale("en");
    expect(
      telegramChallengeRelativeLabel({
        valid: true,
        expired: false,
        secondsRemaining: 1,
        minutesRemaining: 1,
      }),
    ).toBe("Expires in 1 second");
    expect(
      telegramChallengeRelativeLabel({
        valid: true,
        expired: false,
        secondsRemaining: 120,
        minutesRemaining: 2,
      }),
    ).toBe("Expires in about 2 minutes");
  });
});

describe("Telegram link view", () => {
  it("keeps an existing link removable when the gateway is disabled", () => {
    expect(telegramLinkView(false, true)).toBe("linked");
  });

  it("blocks only new links when the gateway is disabled", () => {
    expect(telegramLinkView(false, false)).toBe("disabled");
    expect(telegramLinkView(true, false)).toBe("available");
  });
});
