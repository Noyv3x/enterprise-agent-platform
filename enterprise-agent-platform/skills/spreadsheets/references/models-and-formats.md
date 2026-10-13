# Models, formats and edit limits

## Sheet roles
| Sheet | Contents |
|---|---|
| `说明` (optional) | purpose, how to use, colour legend, version/date, owner |
| `假设` | every editable input: label, value, unit, source, date. Named cells (`wb.define_name("税率", "=假设!$B$5")`) |
| data | one header row, typed columns, unique key if any, no totals mixed into data, no merged cells |
| `汇总` | formulas referencing data/assumptions (SUMIFS, INDEX/MATCH), charts |
| `核对` (models) | checks that must be 0 / TRUE: parts sum to total, balance ties, no negative stock |

## Number formats (Excel format codes)
| Meaning | Code |
|---|---|
| integer with separators | `#,##0` |
| money 2 dp | `#,##0.00`; with symbol `"¥"#,##0.00` |
| 万元 / 亿元 | Excel cannot scale by 10,000 in a format code: store values in the stated unit and put the unit in the header |
| percentage (value 0.123) | `0.0%` |
| date | `yyyy-mm-dd`; Chinese `yyyy"年"m"月"d"日"` |
| negative in red | `#,##0.00;[Red]-#,##0.00` |
| text-looking number (IDs, phone) | store as string; format `@`. Never as number (leading zeros, 18-digit IDs lose precision) |

## Formula discipline
- Absolute refs for assumptions (`$B$4`) or names; relative for row-wise calcs.
- One formula per column pattern; no hand-typed overrides inside a formula column.
- Percent-change: `=IF(C2=0,0,D2/C2-1)`; guard divisions; no `#DIV/0!` visible in outputs.
- Cross-sheet names with Chinese or spaces need quotes in A1 refs written by openpyxl: `'预算 明细'!A1`.
- Dynamic-array functions (`FILTER`, `UNIQUE`, `XLOOKUP`, `LET`) fail in WPS/older Excel and in XlsxWriter without prefixes: avoid.
- Array/volatile: avoid `OFFSET`, `INDIRECT`, `TODAY()` in historical reports (dates must not change on open).

## Python-side reconciliation pattern
```python
rows = [...]                           # raw data
budget = [v*(1+g) if k=="人力" else v for ...]   # same logic as the formulas
formula(ws, r, 3, "=IF(B2=\"人力\",C2*(1+人力增幅),C2)", budget[i], f["money"])
assert abs(sum(budget) - total_cached) < 1e-6   # totals tie across sheets
```

## Charts
`ws.insert_chart("E3", chart)` with `categories`/`values` as `=Sheet!$A$2:$A$6`. Column/bar for comparison, line for time, pie only for ≤ 6 parts summing to 100 %. Title states the message, axis titles carry units, data labels on, one palette, no 3-D. Charts reference cells: a chart is only as correct as its range.

## Editing existing files with openpyxl 3.0.x
```python
wb = openpyxl.load_workbook(src)            # formulas preserved as text
ws = wb["数据"]; ws["D5"] = 1234; ws.append([...])
wb.save(dst)                                # new filename; cached values are gone
```
- `load_workbook(src, data_only=True)` gives cached values (read-only use; never save that workbook over formulas).
- Lost on save: charts, pivot tables, slicers, shapes/text boxes, form controls, external-link caches, VBA (unless `keep_vba`), some conditional formats. Check `unzip -l`.
- Preserved: values, formulas, styles, number formats, merged cells, column widths, defined names, simple data validation, images (needs Pillow).
- After a save the file has no cached values: say "values refresh when opened in Excel/WPS", and for the platform viewer rewrite as a new XlsxWriter workbook if previewing matters.
- Large inputs (> 100k rows): `read_only=True` for reading; write new output with `xlsxwriter` `constant_memory`.
