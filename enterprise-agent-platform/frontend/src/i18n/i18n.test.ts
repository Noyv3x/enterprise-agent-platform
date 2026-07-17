import { afterEach, describe, expect, it } from "vitest";
import { messages } from "./catalog";
import { adminMessages } from "./messages/admin";
import { chatMessages } from "./messages/chat";
import { coreMessages } from "./messages/core";
import { workspaceMessages } from "./messages/workspace";
import { previewMessages } from "./messages/preview";
import { scheduledTaskMessages } from "./messages/scheduledTasks";
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

  it("updates document language and metadata", () => {
    const attributes: Record<string, string> = {};
    const target = {
      documentElement: { lang: "zh-CN" },
      title: "",
      querySelector: () => ({ setAttribute: (name: string, value: string) => { attributes[name] = value; } }),
    };
    applyDocumentLocale("en", target);
    expect(target.documentElement.lang).toBe("en");
    expect(target.title).toBe("ubitech agent");
    expect(attributes.content).toContain("channels");
  });
});

describe("translation catalogs", () => {
  it("defines every message in all three locales", () => {
    for (const definition of Object.values(messages)) {
      expect(Object.keys(definition).sort()).toEqual(["en", "zh-CN", "zh-TW"]);
    }
  });

  it("keeps every localized message and plural branch non-empty", () => {
    for (const [key, definition] of Object.entries(messages)) {
      for (const locale of ["zh-CN", "en", "zh-TW"] as const) {
        const value = definition[locale];
        const templates = typeof value === "string" ? [value] : Object.values(value);
        expect(templates.length, `${key} ${locale} templates`).toBeGreaterThan(0);
        for (const template of templates) {
          expect(template.trim(), `${key} ${locale} empty template`).not.toBe("");
        }
      }
    }
  });

  it("keeps interpolation parameters aligned across locales", () => {
    const parameters = (value: string | Record<string, string>) => {
      const templates = typeof value === "string" ? [value] : Object.values(value);
      return [...new Set(templates.flatMap((template) => [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1])))].sort();
    };
    for (const [key, definition] of Object.entries(messages)) {
      expect(parameters(definition.en), `${key} English parameters`).toEqual(parameters(definition["zh-CN"]));
      expect(parameters(definition["zh-TW"]), `${key} Traditional Chinese parameters`).toEqual(
        parameters(definition["zh-CN"]),
      );
    }
  });

  it("does not shadow keys while merging domain catalogs", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const domain of [coreMessages, adminMessages, chatMessages, workspaceMessages, previewMessages, scheduledTaskMessages]) {
      for (const key of Object.keys(domain)) {
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(Object.keys(messages).length);
  });

  it("translates fixed messages and keeps the imperative locale current", () => {
    expect(translate("zh-CN", "auth.login")).toBe("登录");
    expect(translate("en", "auth.login")).toBe("Sign in");
    expect(translate("zh-TW", "auth.login")).toBe("登入");
    setCurrentLocale("en");
    expect(getCurrentLocale()).toBe("en");
    expect(t("common.retry")).toBe("Retry");
  });
});
