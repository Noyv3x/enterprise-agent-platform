// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh module per test: the kept records also live in module memory. */
async function load() {
  vi.resetModules();
  return import("./frameStorage");
}

/** A snapshot of about `kb` KiB. */
const sized = (kb: number) => ({ blob: "x".repeat(kb * 1024 - 20) });
const kept = () => Object.keys(window.localStorage).filter((key) => key.startsWith("eap-artifact-storage:")).sort();

describe("frameStorage", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps all pages within the total budget, dropping the least recently used first", async () => {
    const { frameStorageKey, saveFrameStorage, TOTAL_BUDGET_BYTES } = await load();
    expect(TOTAL_BUDGET_BYTES).toBe(1024 * 1024);
    // Four pages of 240 KiB fit; the fifth pushes the oldest out.
    for (const id of [1, 2, 3, 4]) saveFrameStorage(frameStorageKey(7, id), sized(240));
    expect(kept()).toEqual([1, 2, 3, 4].map((id) => frameStorageKey(7, id)));
    saveFrameStorage(frameStorageKey(7, 5), sized(240));
    expect(kept()).toEqual([2, 3, 4, 5].map((id) => frameStorageKey(7, id)));
    const total = kept().reduce((sum, key) => sum + new TextEncoder().encode(window.localStorage.getItem(key)!).length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET_BYTES);
  });

  it("counts seeding a page as a use, and reads records an earlier tab kept", async () => {
    const first = await load();
    for (const id of [1, 2, 3, 4]) first.saveFrameStorage(first.frameStorageKey(7, id), sized(240));

    // A reloaded app (empty memory) seeds page 1 from storage, which makes page 2 the oldest.
    const { frameStorageKey, saveFrameStorage, seededFrameUrl } = await load();
    expect(seededFrameUrl("/artifact-view/t/a.html", frameStorageKey(7, 1))).toMatch(/#__eap=/);
    saveFrameStorage(frameStorageKey(7, 5), sized(240));
    expect(kept()).toEqual([1, 3, 4, 5].map((id) => frameStorageKey(7, id)));
  });

  it("drops unreadable records first and clears a page whose snapshot is empty or over the cap", async () => {
    const { frameStorageKey, loadFrameStorage, saveFrameStorage, STORAGE_CAP_BYTES } = await load();
    window.localStorage.setItem(frameStorageKey(7, 9), `not json ${"x".repeat(30 * 1024)}`);
    window.localStorage.setItem("eap-theme", "dark");
    // Four pages of 250 KiB plus the unreadable 30 KiB are over the budget: the unreadable record goes, the pages stay.
    for (const id of [1, 2, 3, 4]) saveFrameStorage(frameStorageKey(7, id), sized(250));
    expect(kept()).toEqual([1, 2, 3, 4].map((id) => frameStorageKey(7, id)));
    expect(loadFrameStorage(frameStorageKey(7, 9))).toBeNull();
    // The app's own keys are never touched.
    expect(window.localStorage.getItem("eap-theme")).toBe("dark");

    saveFrameStorage(frameStorageKey(7, 1), {});
    saveFrameStorage(frameStorageKey(7, 2), { big: "x".repeat(STORAGE_CAP_BYTES) });
    expect(kept()).toEqual([3, 4].map((id) => frameStorageKey(7, id)));
    expect(loadFrameStorage(frameStorageKey(7, 1))).toBeNull();
  });
});
