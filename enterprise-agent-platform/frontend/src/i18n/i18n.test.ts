import { afterEach, describe, expect, it } from "vitest";
import {
  LOCALE_STORAGE_KEY,
  applyDocumentLocale,
  detectBrowserLocale,
  detectLocale,
  getCurrentLocale,
  normalizeLocale,
  setCurrentLocale,
  t,
  translate,
} from ".";

afterEach(() => setCurrentLocale("zh-CN"));

describe("locale normalization", () => {
  it("normalizes supported language families", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("zh_Hant_HK")).toBe("zh-TW");
    expect(normalizeLocale("zh-MO")).toBe("zh-TW");
    expect(normalizeLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("fr-FR")).toBeNull();
  });

  it("prefers storage and otherwise checks browser languages in order", () => {
    const storage = { getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? "zh-TW" : null) };
    expect(detectLocale(storage, ["en-US"])).toBe("zh-TW");
    expect(detectLocale({ getItem: () => "invalid" }, ["fr-FR", "en-GB"])).toBe("en");
    expect(detectLocale(null, ["fr-FR"])).toBe("zh-CN");
  });

  it("survives unavailable storage", () => {
    expect(
      detectLocale(
        {
          getItem() {
            throw new Error("blocked");
          },
        },
        ["zh-TW"],
      ),
    ).toBe("zh-TW");
  });

  it("survives a browser whose localStorage getter is blocked", () => {
    const source = {
      navigator: { language: "en-US", languages: ["en-US"] },
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    };
    expect(detectBrowserLocale(source)).toBe("en");
  });

  it("updates document language without taking ownership of deployment metadata", () => {
    const target = {
      documentElement: { lang: "zh-CN" },
    };
    applyDocumentLocale("en", target);
    expect(target.documentElement.lang).toBe("en");
  });
});

describe("translation", () => {
  it("translates with parameters and keeps the imperative locale current", () => {
    expect(translate("zh-CN", "app.description", { product: "Agent" })).toBe("Agent - 公共频道、个人 AI 与运行时管理。");
    expect(translate("zh-TW", "app.description", { product: "Agent" })).toBe("Agent - 公共頻道、個人 AI 與執行環境管理。");
    setCurrentLocale("en");
    expect(getCurrentLocale()).toBe("en");
    expect(t("app.description", { product: "Agent" })).toBe("Agent - public channels, Personal AI, and runtime management.");
  });
});
