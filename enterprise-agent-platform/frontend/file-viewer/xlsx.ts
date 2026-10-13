import { read, utils, type CellObject, type Range, type WorkBook, type WorkSheet } from "xlsx";
import { messages } from "./messages";

const MAX_ROWS = 2000;
const MAX_COLS = 100;
const MAX_MERGES = 10_000;
// Every merge is clipped to the drawn grid; this bounds the total cells all merges may touch, however many overlap.
const MERGE_CELL_BUDGET = MAX_ROWS * MAX_COLS * 2;

export interface Span {
  rows: number;
  cols: number;
}

/** Merge origins and the cells they cover, clipped to rows 0..rowEnd and columns 0..colEnd, in bounded time. */
export function mergeLayout(merges: readonly Range[], rowEnd: number, colEnd: number) {
  const starts = new Map<string, Span>();
  const covered = new Set<string>();
  let budget = MERGE_CELL_BUDGET;
  for (const merge of merges.slice(0, MAX_MERGES)) {
    if (merge.s.r > rowEnd || merge.s.c > colEnd) continue;
    const rows = Math.min(merge.e.r, rowEnd) - merge.s.r + 1;
    const cols = Math.min(merge.e.c, colEnd) - merge.s.c + 1;
    if (rows < 1 || cols < 1 || rows * cols > budget) break;
    budget -= rows * cols;
    starts.set(`${merge.s.r}:${merge.s.c}`, { rows, cols });
    for (let r = merge.s.r; r < merge.s.r + rows; r++) {
      for (let c = merge.s.c; c < merge.s.c + cols; c++) if (r !== merge.s.r || c !== merge.s.c) covered.add(`${r}:${c}`);
    }
  }
  return { starts, covered };
}

function shown(cell: CellObject | undefined): string {
  if (!cell) return "";
  // A stub (`z`) is a cell without a stored result; its `v` is a placeholder, not a value.
  if (cell.t === "z") return cell.f ? `=${cell.f}` : "";
  if (cell.w !== undefined && cell.w !== "") return cell.w;
  if (cell.v !== undefined && cell.v !== null && cell.v !== "") return String(cell.v);
  // No cached result (a file written by a library that does not calculate): show the formula itself.
  return cell.f ? `=${cell.f}` : "";
}

function grid(sheet: WorkSheet): HTMLElement {
  const text = messages();
  const wrap = document.createElement("div");
  wrap.className = "sheet";
  if (!sheet["!ref"]) {
    wrap.textContent = text.empty;
    return wrap;
  }
  const range = utils.decode_range(sheet["!ref"]);
  const rowEnd = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
  const colEnd = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
  const { starts, covered } = mergeLayout(sheet["!merges"] ?? [], rowEnd, colEnd);
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  head.append(document.createElement("th"));
  for (let c = range.s.c; c <= colEnd; c++) {
    const th = document.createElement("th");
    th.textContent = utils.encode_col(c);
    head.append(th);
  }
  const hidden = sheet["!rows"] ?? [];
  const body = table.createTBody();
  for (let r = range.s.r; r <= rowEnd; r++) {
    if (hidden[r]?.hidden) continue;
    const row = body.insertRow();
    const label = document.createElement("th");
    label.textContent = String(r + 1);
    row.append(label);
    for (let c = range.s.c; c <= colEnd; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = sheet[utils.encode_cell({ r, c })] as CellObject | undefined;
      const td = row.insertCell();
      td.textContent = shown(cell);
      const span = starts.get(`${r}:${c}`);
      if (span) {
        if (span.rows > 1) td.rowSpan = span.rows;
        if (span.cols > 1) td.colSpan = span.cols;
        td.classList.add("merged");
      }
      if (cell?.t === "n") td.classList.add("num");
    }
  }
  wrap.append(table);
  // `sheetRows` clips `!ref` while parsing; `!fullref` keeps the sheet's real extent.
  const full = sheet["!fullref"] ? utils.decode_range(sheet["!fullref"]) : range;
  if (full.e.r > rowEnd || full.e.c > colEnd) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = text.truncated(MAX_ROWS, MAX_COLS);
    wrap.append(note);
  }
  return wrap;
}

export async function render(data: ArrayBuffer, root: HTMLElement, stacked = false) {
  const book: WorkBook = read(new Uint8Array(data), { type: "array", cellFormula: true, cellText: true, cellDates: true, sheetStubs: true, sheetRows: MAX_ROWS + 1 });
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  tabs.setAttribute("role", "tablist");
  const panes = document.createElement("div");
  const buttons: HTMLButtonElement[] = [];
  const views: HTMLElement[] = [];
  const fills: Array<() => void> = [];
  const select = (index: number) => {
    buttons.forEach((button, i) => {
      button.setAttribute("aria-selected", String(i === index));
      views[i].hidden = i !== index;
    });
  };
  book.SheetNames.forEach((name, index) => {
    const hidden = (book.Workbook?.Sheets?.[index]?.Hidden ?? 0) !== 0;
    if (hidden) return;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.textContent = name;
    // A sheet's grid is built when its tab is first shown; the stacked self-check layout draws every sheet at once.
    const view = document.createElement("div");
    view.setAttribute("role", "tabpanel");
    const fill = () => {
      if (view.childElementCount) return;
      view.append(grid(book.Sheets[name]));
      if (stacked) view.prepend(Object.assign(document.createElement("h2"), { textContent: name, className: "sheet-name" }));
    };
    if (stacked) fill();
    view.hidden = !stacked;
    button.addEventListener("click", () => {
      fill();
      select(buttons.indexOf(button));
    });
    buttons.push(button);
    views.push(view);
    tabs.append(button);
    panes.append(view);
    fills.push(fill);
  });
  if (!buttons.length) throw new Error("The workbook has no visible sheet");
  if (stacked) {
    root.replaceChildren(panes);
    return;
  }
  root.replaceChildren(tabs, panes);
  fills[0]();
  select(0);
}
