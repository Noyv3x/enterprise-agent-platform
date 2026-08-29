import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLocale } from "../i18n";
import { oauthProviderErrorText } from "./oauth";
import type { OAuthProvider } from "../types";

afterEach(() => setCurrentLocale("zh-CN"));

describe("localized OAuth helpers", () => {
  it("localizes the client prefix while preserving server error details", () => {
    setCurrentLocale("zh-TW");
    const provider = {
      last_auth_error: { relogin_required: true, message: "invalid_grant" },
    } as OAuthProvider;
    expect(oauthProviderErrorText(provider)).toBe("需要重新驗證：invalid_grant");
  });
});
