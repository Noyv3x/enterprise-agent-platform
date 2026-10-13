import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mergeLayout } from "./xlsx";
import { MAX_ENTRIES, MAX_XML_PART_BYTES, withinZipLimits } from "./zipLimits";

async function zip(files: Record<string, string | Uint8Array>) {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

describe("archive limits", () => {
  it("accepts an ordinary Office-shaped archive", async () => {
    expect(withinZipLimits(await zip({ "[Content_Types].xml": "<x/>", "word/document.xml": "<d>中文</d>" }))).toBe(true);
  });

  it("refuses too many entries", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_ENTRIES; i++) files[`p${i}.txt`] = "x";
    expect(withinZipLimits(await zip(files))).toBe(false);
  });

  it("refuses a part that declares more than its limit uncompressed, however small it is compressed", async () => {
    const bomb = new Uint8Array(MAX_XML_PART_BYTES + 1);
    const data = await zip({ "word/document.xml": bomb });
    expect(data.byteLength).toBeLessThan(100_000);
    expect(withinZipLimits(data)).toBe(false);
  });

  it("refuses a total over the limit made of allowed parts", async () => {
    const part = new Uint8Array(30 * 1024 * 1024);
    expect(withinZipLimits(await zip({ "a.bin": part, "b.bin": part, "c.bin": part }))).toBe(false);
  });

  it("refuses data that is not a zip", () => {
    expect(withinZipLimits(new TextEncoder().encode("not a zip at all, just text").buffer as ArrayBuffer)).toBe(false);
    expect(withinZipLimits(new ArrayBuffer(0))).toBe(false);
  });
});

describe("merge layout", () => {
  const range = (r1: number, c1: number, r2: number, c2: number) => ({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });

  it("records an origin with its span and the cells it covers", () => {
    const { starts, covered } = mergeLayout([range(6, 0, 6, 3)], 100, 100);
    expect(starts.get("6:0")).toEqual({ rows: 1, cols: 4 });
    expect([...covered].sort()).toEqual(["6:1", "6:2", "6:3"]);
  });

  it("clips a huge merge to the drawn grid", () => {
    const { starts } = mergeLayout([range(0, 0, 1_000_000, 16_000)], 9, 4);
    expect(starts.get("0:0")).toEqual({ rows: 10, cols: 5 });
  });

  it("stays bounded for a bomb of many overlapping huge merges", () => {
    const bomb = Array.from({ length: 50_000 }, (_, i) => range(0, i % 3, 1_000_000, 16_000));
    const began = performance.now();
    const { covered } = mergeLayout(bomb, 1999, 99);
    expect(performance.now() - began).toBeLessThan(2000);
    expect(covered.size).toBeLessThanOrEqual(2000 * 100 * 2);
  });
});
