"""XlsxWriter helpers for NEW workbooks: formulas WITH cached values, number formats, charts.

    import sys; sys.path.insert(0, "/opt/agent-platform/skills/builtin/spreadsheets/scripts")
    from xlsx_kit import *

Why XlsxWriter for new files: openpyxl and XlsxWriter never calculate formulas. openpyxl stores
none of the results, so previews, pandas and `data_only=True` see empty cells until Excel
recalculates. XlsxWriter lets you store the result you computed in Python next to the formula
(`write_formula(cell, formula, fmt, value)`), so every viewer shows numbers AND Excel still recalculates.
"""
import xlsxwriter

FONT = "Microsoft YaHei"   # Chinese-capable; Excel/WPS substitute if missing
FMT = {
    "int": "#,##0", "money": "#,##0.00", "wan": '#,##0.0"万"', "pct": "0.0%",
    "cny": '"¥"#,##0.00', "date": "yyyy-mm-dd", "ratio": "0.00",
    "neg_red": '#,##0.00;[Red]-#,##0.00',
}


def workbook(path):
    wb = xlsxwriter.Workbook(path, {"default_date_format": "yyyy-mm-dd"})
    wb.formats[0].set_font_name(FONT); wb.formats[0].set_font_size(10)
    return wb


def fmt(wb, **kw):
    kw.setdefault("font_name", FONT); kw.setdefault("font_size", 10)
    if "num" in kw:
        kw["num_format"] = FMT.get(kw["num"], kw["num"]); del kw["num"]
    return wb.add_format(kw)


def styles(wb):
    """Shared formats: header, text, input (blue font + light yellow fill = editable assumption),
    calc (black), total (top border, bold), per number type."""
    f = {"title": fmt(wb, bold=True, font_size=16), "note": fmt(wb, font_color="#52606D", text_wrap=True, valign="top"),
         "head": fmt(wb, bold=True, font_color="#FFFFFF", bg_color="#1D4ED8", border=1, border_color="#CBD2D9", text_wrap=True, valign="vcenter", align="center"),
         "text": fmt(wb, border=1, border_color="#CBD2D9", text_wrap=True, valign="top")}
    for name in ("int", "money", "pct", "wan", "date", "ratio"):
        f[name] = fmt(wb, num=name, border=1, border_color="#CBD2D9")
        f["in_" + name] = fmt(wb, num=name, border=1, border_color="#CBD2D9", font_color="#0000FF", bg_color="#FFF9DB")
        f["tot_" + name] = fmt(wb, num=name, bold=True, top=1, bottom=6)
    f["in_text"] = fmt(wb, border=1, border_color="#CBD2D9", font_color="#0000FF", bg_color="#FFF9DB")
    return f


def header_row(ws, row, labels, f, widths=None, freeze=True):
    for c, label in enumerate(labels):
        ws.write(row, c, label, f["head"])
        if widths:
            ws.set_column(c, c, widths[c])
    ws.set_row(row, 24)
    if freeze:
        ws.freeze_panes(row + 1, 0)


def formula(ws, row, col, expr, value, cell_format=None):
    """Write an Excel formula plus the value computed in Python (cached result). `expr` starts with '='."""
    ws.write_formula(row, col, expr, cell_format, value)


def add_column_chart(wb, ws, title, categories, values, anchor, y_title="", kind="column", size=(560, 300)):
    """categories/values are '=Sheet!$A$2:$A$6' style ranges."""
    ch = wb.add_chart({"type": kind})
    ch.add_series({"categories": categories, "values": values, "fill": {"color": "#1D4ED8"}, "data_labels": {"value": True}})
    ch.set_title({"name": title, "name_font": {"name": FONT, "size": 12}})
    ch.set_legend({"none": True}); ch.set_y_axis({"name": y_title, "num_font": {"name": FONT}, "major_gridlines": {"visible": True, "line": {"color": "#E4E7EB"}}})
    ch.set_x_axis({"num_font": {"name": FONT}}); ch.set_size({"width": size[0], "height": size[1]})
    ws.insert_chart(anchor, ch)
