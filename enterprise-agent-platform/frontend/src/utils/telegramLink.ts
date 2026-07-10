export interface TelegramChallengeTiming {
  valid: boolean;
  expired: boolean;
  secondsRemaining: number;
  minutesRemaining: number;
}

export type TelegramLinkView = "linked" | "available" | "disabled";

/** Existing account ownership outranks gateway availability: administrators may
 * disable new links while users still need a way to remove a persisted link. */
export function telegramLinkView(gatewayEnabled: boolean, linked: boolean): TelegramLinkView {
  if (linked) return "linked";
  return gatewayEnabled ? "available" : "disabled";
}

/** Normalize a server UNIX expiry for deterministic rendering and tests. */
export function telegramChallengeTiming(
  expiresAt: number | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramChallengeTiming {
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= 0) {
    return { valid: false, expired: false, secondsRemaining: 0, minutesRemaining: 0 };
  }
  const secondsRemaining = Math.max(0, Math.ceil(expiry - nowSeconds));
  return {
    valid: true,
    expired: secondsRemaining === 0,
    secondsRemaining,
    minutesRemaining: Math.max(1, Math.ceil(secondsRemaining / 60)),
  };
}

export function telegramChallengeRelativeLabel(timing: TelegramChallengeTiming): string {
  if (!timing.valid) return "有效期未知";
  if (timing.expired) return "绑定码已过期";
  if (timing.secondsRemaining < 60) return `${timing.secondsRemaining} 秒后过期`;
  return `约 ${timing.minutesRemaining} 分钟后过期`;
}
