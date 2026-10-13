#!/usr/bin/env python3
"""Example: Chinese department budget workbook (Assumptions / Data / Summary, formulas with cached values,
chart, validation). Usage: example_budget.py OUT.xlsx"""
import sys
sys.path.insert(0, "/opt/agent-platform/skills/builtin/spreadsheets/scripts")
from xlsx_kit import *

out = sys.argv[1] if len(sys.argv) > 1 else "budget.xlsx"
wb = workbook(out); f = styles(wb)

# --- Assumptions: every editable number lives here, referenced by name -------------------------
a = wb.add_worksheet("假设"); a.set_column(0, 0, 22); a.set_column(1, 1, 14); a.set_column(2, 2, 46)
a.write(0, 0, "预算假设（蓝字黄底可修改）", f["title"])
header_row(a, 2, ["项目", "数值", "说明 / 来源"], f, freeze=False)
assumptions = [("人力成本年增幅", 0.05, "pct", "HR 2026-09 调薪方案"), ("差旅预算上限（万元）", 18.0, "money", "财务制度 §4.2"),
               ("增值税率", 0.06, "pct", "咨询服务适用税率")]
for i, (label, val, kind, src) in enumerate(assumptions):
    a.write(3 + i, 0, label, f["text"]); a.write(3 + i, 1, val, f["in_" + kind]); a.write(3 + i, 2, src, f["text"])
wb.define_name("人力增幅", "=假设!$B$4"); wb.define_name("差旅上限", "=假设!$B$5")

# --- Data: one row per record, no merged cells, no blank rows ----------------------------------
d = wb.add_worksheet("预算明细")
header_row(d, 0, ["部门", "科目", "2025 实际（万元）", "2026 预算（万元）", "同比", "超限"], f, widths=[12, 12, 16, 16, 10, 10])
rows = [("研发", "人力", 820.0), ("研发", "差旅", 14.5), ("市场", "人力", 310.0), ("市场", "差旅", 21.0), ("运营", "人力", 450.0), ("运营", "差旅", 9.2)]
growth, cap = assumptions[0][1], assumptions[1][1]
budget = []
for i, (dept, item, actual) in enumerate(rows):
    r = i + 1; xl = r + 1
    value = round(actual * (1 + growth), 6) if item == "人力" else actual
    budget.append(value)
    d.write(r, 0, dept, f["text"]); d.write(r, 1, item, f["text"]); d.write(r, 2, actual, f["in_money"])
    formula(d, r, 3, f'=IF(B{xl}="人力",C{xl}*(1+人力增幅),C{xl})', value, f["money"])
    formula(d, r, 4, f"=IF(C{xl}=0,0,D{xl}/C{xl}-1)", value / actual - 1, f["pct"])
    over = item == "差旅" and value > cap
    formula(d, r, 5, f'=IF(AND(B{xl}="差旅",D{xl}>差旅上限),"是","否")', "是" if over else "否", f["text"])
n = len(rows); last = n + 1
total_actual, total_budget = sum(r[2] for r in rows), sum(budget)
d.write(n + 1, 0, "合计", f["tot_money"]); d.write(n + 1, 1, "", f["tot_money"])
formula(d, n + 1, 2, f"=SUM(C2:C{last})", total_actual, f["tot_money"])
formula(d, n + 1, 3, f"=SUM(D2:D{last})", total_budget, f["tot_money"])
formula(d, n + 1, 4, f"=D{n + 2}/C{n + 2}-1", total_budget / total_actual - 1, f["tot_pct"])
d.data_validation(1, 2, n, 2, {"validate": "decimal", "criteria": ">=", "value": 0, "error_message": "请输入非负数"})
d.autofilter(0, 0, n, 5)

# --- Summary: SUMIFS by department + chart -----------------------------------------------------
s = wb.add_worksheet("汇总"); s.set_column(0, 0, 12); s.set_column(1, 2, 18)
s.write(0, 0, "各部门 2026 预算汇总", f["title"])
header_row(s, 2, ["部门", "2026 预算（万元）", "占比"], f, freeze=False)
depts = ["研发", "市场", "运营"]
dept_total = {k: sum(b for (dd, _, _), b in zip(rows, budget) if dd == k) for k in depts}
for i, k in enumerate(depts):
    r = 3 + i; xl = r + 1
    s.write(r, 0, k, f["text"])
    formula(s, r, 1, f"=SUMIFS(预算明细!$D$2:$D${last},预算明细!$A$2:$A${last},A{xl})", dept_total[k], f["money"])
    formula(s, r, 2, f"=B{xl}/SUM($B$4:$B$6)", dept_total[k] / total_budget, f["pct"])
add_column_chart(wb, s, "各部门 2026 预算（万元）", "=汇总!$A$4:$A$6", "=汇总!$B$4:$B$6", "E3", y_title="万元")
wb.close()
# Python-side reconciliation: the numbers cached in the file must equal an independent computation.
assert abs(sum(dept_total.values()) - total_budget) < 1e-6
print(out)
