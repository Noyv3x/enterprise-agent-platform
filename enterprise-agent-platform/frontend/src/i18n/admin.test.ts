import { describe, expect, it } from "vitest";
import { translate } from ".";

describe("admin translations", () => {
  it("uses English singular and plural forms for admin counts", () => {
    expect(translate("en", "admin.model.count", { count: 1 })).toBe("1 available model");
    expect(translate("en", "admin.model.count", { count: 2 })).toBe("2 available models");
    expect(translate("en", "admin.audit.messageCount", { count: 1 })).toBe("1 message");
    expect(translate("en", "admin.audit.messageCount", { count: 3 })).toBe("3 messages");
  });

  it("provides Traditional Chinese management labels", () => {
    expect(translate("zh-TW", "admin.page.security.label")).toBe("公網安全");
    expect(translate("zh-TW", "admin.accounts.permissionGroup")).toBe("權限群組");
    expect(translate("zh-TW", "admin.group.advanced")).toBe("進階");
  });

  it("localizes grouped navigation and account confirmations", () => {
    expect(translate("zh-CN", "admin.group.people")).toBe("成员与数据");
    expect(translate("en", "admin.group.agents")).toBe("Agents & access");
    expect(translate("en", "admin.accounts.impersonateConfirm", { name: "Avery" }))
      .toContain("Avery");
  });
});
