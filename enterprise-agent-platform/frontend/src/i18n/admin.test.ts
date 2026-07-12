import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELD_GROUP_KEYS,
  CONFIG_FIELD_LABEL_KEYS,
  CONFIG_FIELD_OPTION_KEYS,
} from "./messages/admin";
import { messages } from "./catalog";
import { translate } from ".";

describe("admin translations", () => {
  it("covers every managed config field with a valid catalog key", () => {
    expect(Object.keys(CONFIG_FIELD_LABEL_KEYS)).toHaveLength(151);
    for (const key of [
      ...Object.values(CONFIG_FIELD_LABEL_KEYS),
      ...Object.values(CONFIG_FIELD_GROUP_KEYS),
      ...Object.values(CONFIG_FIELD_OPTION_KEYS),
    ]) {
      expect(messages[key]).toBeDefined();
    }
  });

  it("uses English singular and plural forms for admin counts", () => {
    expect(translate("en", "admin.model.count", { count: 1 })).toBe("1 model from Hermes");
    expect(translate("en", "admin.model.count", { count: 2 })).toBe("2 models from Hermes");
    expect(translate("en", "admin.audit.messageCount", { count: 1 })).toBe("1 message");
    expect(translate("en", "admin.audit.messageCount", { count: 3 })).toBe("3 messages");
  });

  it("provides Traditional Chinese management labels", () => {
    expect(translate("zh-TW", "admin.page.security.label")).toBe("公網安全");
    expect(translate("zh-TW", "admin.accounts.permissionGroup")).toBe("權限群組");
  });
});
