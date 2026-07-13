import { describe, expect, it } from "vitest";
import { ADMIN_PAGES } from "../../lib/constants";
import { ADMIN_PAGE_GROUPS } from "./AdminPager";

describe("grouped admin navigation", () => {
  it("places every administration page in exactly one group", () => {
    const groupedPages = ADMIN_PAGE_GROUPS.flatMap((group) => [...group.pages]);

    expect(new Set(groupedPages).size).toBe(groupedPages.length);
    expect(new Set(groupedPages)).toEqual(new Set(ADMIN_PAGES.map((page) => page.id)));
  });

  it("keeps the intended four-group information architecture", () => {
    expect(ADMIN_PAGE_GROUPS.map((group) => group.id)).toEqual([
      "people",
      "agents",
      "system",
      "advanced",
    ]);
  });
});
