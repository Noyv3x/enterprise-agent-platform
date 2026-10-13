import { describe, expect, it } from 'vitest';
import { parsePatch } from './computerView';

const HEADER = '--- a.md\n+++ a.md\n';

describe('parsePatch', () => {
  it('numbers a whole patch without a row for the text after its final newline', () => {
    const parsed = parsePatch(`${HEADER}@@ -1,3 +1,3 @@\n one\n-two\n+二\n three\n\\ No newline at end of file\n`);
    expect(parsed.rows.map((row) => [row.type, row.old, row.new, row.text])).toEqual([
      ['hunk', null, null, '@@ -1,3 +1,3 @@'], ['ctx', 1, 1, 'one'], ['del', 2, null, 'two'], ['add', null, 2, '二'], ['ctx', 3, 3, 'three'],
    ]);
    expect(parsed).toMatchObject({ added: 1, removed: 1, cut: false });
  });

  it('marks a patch cut on whole lines inside a hunk as cut, with no invented context row', () => {
    const parsed = parsePatch(`${HEADER}@@ -1,4 +1,4 @@\n one\n-two\n+二\n`);
    expect(parsed.rows.map((row) => row.type)).toEqual(['hunk', 'ctx', 'del', 'add']);
    expect(parsed).toMatchObject({ added: 1, removed: 1, cut: true });
    // A hunk one line short is cut too (the trailing empty string must not complete it).
    expect(parsePatch(`${HEADER}@@ -1,2 +1,2 @@\n one\n`).cut).toBe(true);
  });

  it('marks an earlier hunk that ends short as cut even when a later one is whole', () => {
    expect(parsePatch(`${HEADER}@@ -1,3 +1,3 @@\n one\n@@ -9 +9 @@\n-x\n+y\n`).cut).toBe(true);
  });
});
