import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../../components/ui/beautiful/primitives/CodeBlock";
import { unifiedDiff } from "./lineDiff";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe("unifiedDiff", () => {
  it("is null for the same lines, whatever the line endings", () => {
    expect(unifiedDiff("a\nb\n", "a\r\nb")).toBeNull();
  });

  it("writes minimal hunks with three lines of context and separates distant changes", () => {
    const before = numbered(20);
    const after = [...before];
    after[1] = "changed 2";
    after.splice(15, 1);
    after.push("line 21");
    expect(unifiedDiff(before.join("\n"), after.join("\n"))).toBe([
      "@@ -1,5 +1,5 @@",
      " line 1",
      "-line 2",
      "+changed 2",
      " line 3",
      " line 4",
      " line 5",
      "@@ -13,8 +13,8 @@",
      " line 13",
      " line 14",
      " line 15",
      "-line 16",
      " line 17",
      " line 18",
      " line 19",
      " line 20",
      "+line 21",
    ].join("\n"));
  });

  it("diffs from and to empty text", () => {
    expect(unifiedDiff("", "a\nb")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
    expect(unifiedDiff("a", "")).toBe("@@ -1,1 +0,0 @@\n-a");
  });

  it("shows a rewrite beyond the edit budget as a replacement", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
    const rows = parseUnifiedDiff(unifiedDiff(before, after)!).rows;
    expect(rows.filter((row) => row.type === "del")).toHaveLength(2000);
    expect(rows.filter((row) => row.type === "add")).toHaveLength(2000);
  });

  it("round-trips through the CodeBlock parser, a removed `-- x` line staying a row", () => {
    const diff = unifiedDiff("select 1;\n-- note\nselect 2;", "select 1;\nselect 2;")!;
    expect(parseUnifiedDiff(diff)).toEqual({
      file: null,
      rows: [
        { num: null, type: "hunk", text: "@@ -1,3 +1,2 @@" },
        { num: 1, type: "ctx", text: "select 1;" },
        { num: 2, type: "del", text: "-- note" },
        { num: 2, type: "ctx", text: "select 2;" },
      ],
    });
  });
});
