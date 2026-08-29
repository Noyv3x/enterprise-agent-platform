import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLocale, t, translate } from ".";

afterEach(() => setCurrentLocale("zh-CN"));

describe("workspace translations", () => {
  it("provides settings messages", () => {
    expect(translate("en", "account.changePassword")).toBe("Change password");
  });

  it("uses the active locale for imperative UI helpers", () => {
    setCurrentLocale("zh-TW");
    expect(t("session.expired")).toBe("工作階段已過期，請重新登入");
  });
});
