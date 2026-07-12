import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLocale, t, translate } from ".";

afterEach(() => setCurrentLocale("zh-CN"));

describe("workspace translations", () => {
  it("provides knowledge and settings messages in all supported locales", () => {
    expect(translate("zh-CN", "knowledge.library")).toBe("条目库");
    expect(translate("en", "knowledge.library")).toBe("Entry library");
    expect(translate("zh-TW", "knowledge.library")).toBe("項目庫");
    expect(translate("en", "account.changePassword")).toBe("Change password");
  });

  it("uses correct English singular and plural forms for dynamic counts", () => {
    expect(translate("en", "knowledge.documentCount", { count: 1 })).toBe("1 document");
    expect(translate("en", "knowledge.documentCount", { count: 2 })).toBe("2 documents");
    expect(translate("en", "knowledge.searchResults", { query: "guide", count: 1 })).toBe(
      "Search “guide”: 1 result",
    );
    expect(translate("en", "telegram.expiresInSeconds", { count: 2 })).toBe(
      "Expires in 2 seconds",
    );
  });

  it("uses the active locale for imperative UI helpers", () => {
    setCurrentLocale("zh-TW");
    expect(t("session.expired")).toBe("工作階段已過期，請重新登入");
  });
});
