import { describe, expect, it } from "vitest";
import { translate } from ".";

describe("admin translations", () => {
  it("uses English singular and plural forms for admin counts", () => {
    expect(translate("en", "admin.model.count", { count: 1 })).toBe("1 available model");
    expect(translate("en", "admin.model.count", { count: 2 })).toBe("2 available models");
    expect(translate("en", "admin.audit.messageCount", { count: 1 })).toBe("1 message");
    expect(translate("en", "admin.audit.messageCount", { count: 3 })).toBe("3 messages");
  });

});
