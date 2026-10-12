import { describe, expect, it } from "vitest";
import { parseDelimited } from "./delimited";

describe("parseDelimited", () => {
  it("reads quoted commas, doubled quotes and line breaks inside quotes", () => {
    const text = '\ufeffname,note,amount\r\n"Lee, Ann","said ""hi""\nthen left",12\r\nBo,plain,3\n';
    expect(parseDelimited(text, ",", 10)).toEqual({
      rows: [["name", "note", "amount"], ["Lee, Ann", 'said "hi"\nthen left', "12"], ["Bo", "plain", "3"]],
      total: 3,
    });
  });

  it("keeps empty fields, skips blank lines and closes an unterminated quote at the end", () => {
    expect(parseDelimited('a,,c\n\n,\r"open,\nend', ",", 10)).toEqual({ rows: [["a", "", "c"], ["", ""], ["open,\nend"]], total: 3 });
  });

  it("splits TSV on tabs, with commas and mid-field quotes literal", () => {
    expect(parseDelimited('city\tpopulation\nParis, FR\t2,100,000\n5" disk\t"a\tb"', "\t", 10).rows).toEqual([
      ["city", "population"],
      ["Paris, FR", "2,100,000"],
      ['5" disk', "a\tb"],
    ]);
  });

  it("keeps the first `limit` records and counts them all", () => {
    const text = ["h", ...Array.from({ length: 2500 }, (_, i) => String(i))].join("\n");
    const table = parseDelimited(text, ",", 1001);
    expect(table.rows).toHaveLength(1001);
    expect(table.rows[1000]).toEqual(["999"]);
    expect(table.total).toBe(2501);
  });
});
