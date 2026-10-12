/** CSV/TSV parsing for the table renderer (RFC 4180, as spreadsheets write it). */

export interface DelimitedTable {
  /** the first `limit` records; the first is the header row */
  rows: string[][];
  /** every record in the text, the header included */
  total: number;
}

/**
 * Splits delimited text into records. A field that starts with `"` is quoted: it may hold the delimiter, line breaks
 * and `""` (one quote) until its closing quote; a quote anywhere else is literal. Records end at LF, CRLF or CR; a
 * byte-order mark, blank lines and the final line break do not make records. Only the first `limit` records are kept,
 * all are counted.
 */
export function parseDelimited(text: string, delimiter: "," | "\t", limit: number): DelimitedTable {
  const rows: string[][] = [];
  let total = 0;
  let record: string[] = [];
  let field = "";
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  const endRecord = () => {
    record.push(field);
    field = "";
    if (record.length > 1 || record[0] !== "") {
      if (total < limit) rows.push(record);
      total += 1;
    }
    record = [];
  };

  while (i < n) {
    const ch = text[i];
    if (ch === '"' && field === "") {
      // A quoted field runs to the next quote that is not doubled.
      i += 1;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) {
          field += text.slice(i);
          i = n;
          break;
        }
        field += text.slice(i, close);
        if (text[close + 1] === '"') {
          field += '"';
          i = close + 2;
        } else {
          i = close + 1;
          break;
        }
      }
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      endRecord();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== "" || record.length > 0) endRecord();
  return { rows, total };
}
