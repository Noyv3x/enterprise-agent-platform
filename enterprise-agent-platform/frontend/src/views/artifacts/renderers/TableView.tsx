/** CSV/TSV artifact as a table: the header row and up to ROW_LIMIT data rows, with a note when more exist. */
import { useMemo } from "react";
import { EmptyState, Notice } from "../../../components/ui/beautiful/controls";
import { useWords } from "../../../words";
import { parseDelimited } from "./delimited";

export const ROW_LIMIT = 1000;

/** A column whose every value reads as a number (1,234.5, -3, 12%) aligns right. */
const NUMBER = /^(?=.*\d)[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?%?$/;

export function TableView({ text, truncated, tsv }: {
  text: string;
  /** the source stopped at its size cap, so the last record may be cut off */
  truncated: boolean;
  tsv: boolean;
}) {
  const w = useWords();
  const table = useMemo(() => {
    const parsed = parseDelimited(text, tsv ? "\t" : ",", ROW_LIMIT + 1);
    // A cut-off source ends mid-record: drop that record unless the shown rows stop before it.
    const total = truncated && parsed.total <= ROW_LIMIT + 1 ? parsed.total - 1 : parsed.total;
    const rows = parsed.rows.slice(0, Math.max(0, total));
    const [header = [], ...body] = rows;
    const columns = Math.max(header.length, ...body.map((row) => row.length));
    const numeric = Array.from({ length: columns }, (_, column) => {
      const values = body.map((row) => row[column]?.trim() ?? "").filter(Boolean);
      return values.length > 0 && values.every((value) => NUMBER.test(value));
    });
    return { header, body, columns, numeric, dataRows: Math.max(0, total - 1) };
  }, [text, truncated, tsv]);

  if (table.columns === 0) {
    return <EmptyState icon="info" title={w("This table is empty", "表格没有内容", "表格沒有內容")} description={w("Download the file to check it.", "可以下载文件检查原始内容。", "可以下載檔案檢查原始內容。")} className="h-full" />;
  }

  const shown = table.body.length;
  const count = (n: number) => n.toLocaleString();
  const note = truncated
    ? {
        title: w(`Showing the first ${count(shown)} rows`, `显示前 ${count(shown)} 行`, `顯示前 ${count(shown)} 列`),
        detail: w("The file is larger than 2 MB, so only its beginning is shown. Download it for every row.", "文件超过 2 MB，只载入了开头部分。下载文件可查看全部数据。", "檔案超過 2 MB，只載入了開頭部分。下載檔案可查看全部資料。"),
      }
    : table.dataRows > shown
      ? {
          title: w(`Showing the first ${count(shown)} of ${count(table.dataRows)} rows`, `显示前 ${count(shown)} 行，共 ${count(table.dataRows)} 行`, `顯示前 ${count(shown)} 列，共 ${count(table.dataRows)} 列`),
          detail: w("Download the file for every row.", "下载文件可查看全部数据。", "下載檔案可查看全部資料。"),
        }
      : null;

  const cell = "border-b border-line px-3 py-2 align-top [&+&]:border-l [tbody_tr:last-child>&]:border-b-0";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {note && <Notice className="m-3 mb-0 shrink-0" title={note.title}>{note.detail}</Notice>}
      <div className="m-3 min-h-0 flex-1 overflow-auto rounded-card bg-surface shadow-card" tabIndex={0} role="region" aria-label={w("Table", "表格", "表格")}>
        <table className="min-w-full border-separate border-spacing-0 text-[12.5px] text-ink tabular-nums">
          <thead className="sticky top-0 z-10">
            <tr>
              <th scope="col" className={`${cell} w-0 bg-inset text-right font-normal text-ink-2 select-none`}>
                <span className="sr-only">{w("Row", "行号", "列號")}</span>
              </th>
              {Array.from({ length: table.columns }, (_, column) => (
                <th key={column} scope="col" className={`${cell} bg-inset font-medium whitespace-nowrap text-ink-2 ${table.numeric[column] ? "text-right" : "text-left"}`}>
                  {table.header[column] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.body.map((row, index) => (
              <tr key={index} className="hover:bg-hover">
                <th scope="row" className={`${cell} w-0 text-right font-mono text-[11px] font-normal text-ink-2 select-none`}>{index + 1}</th>
                {Array.from({ length: table.columns }, (_, column) => (
                  <td key={column} className={`${cell} ${table.numeric[column] ? "text-right" : ""}`}>
                    {/* Short values keep one line; long ones wrap at a readable measure, never squeezed narrower. */}
                    <div className={`w-max max-w-[40ch] whitespace-pre-wrap break-words ${table.numeric[column] ? "ml-auto" : ""}`}>{row[column] ?? ""}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
