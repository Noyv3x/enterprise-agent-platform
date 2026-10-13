#!/usr/bin/env python3
"""Example: 5-slide Chinese business deck (title, KPIs, chart, table, next steps). Usage: example_deck.py OUT.pptx"""
import sys
sys.path.insert(0, "/opt/agent-platform/skills/builtin/presentations/scripts")
from pptx_kit import *

out = sys.argv[1] if len(sys.argv) > 1 else "deck.pptx"
prs = new_deck(); foot = "2026 Q3 经营复盘 · 内部资料"

s = add_slide(prs, "2026 年第三季度经营复盘", notes="开场：本季度三个关键词——订阅增长、毛利改善、硬件承压。")
add_text(s, MARGIN, Inches(2.2), CONTENT_W, Inches(1.2), ["营业收入同比增长 12.4%，订阅业务贡献过半增量"], size=SIZE["body"] + 4, color=ACCENT)
add_text(s, MARGIN, Inches(3.6), CONTENT_W, Inches(1.0), ["华东区域经营分析组", "2026 年 10 月 13 日"], size=SIZE["small"], color=MUTED)

s = add_slide(prs, "收入与毛利双增，订阅业务是主要引擎", notes="数据来源：财务系统 2026-10-10 导出。")
w = (CONTENT_W - Inches(0.6)) // 3
for i, (h, b) in enumerate([("4,820 万", "营业收入，同比 +12.4%"), ("31.8%", "毛利率，较上季度 +1.6 个百分点"), ("94%", "订阅续费率，新增大客户 12 家")]):
    add_card(s, MARGIN + i * (w + Inches(0.3)), Inches(1.9), w, Inches(2.4), h, b)
add_text(s, MARGIN, Inches(4.7), CONTENT_W, Inches(1.6), ["订阅业务毛利率 46.2%，显著高于公司平均", "两个解决方案项目延期，约 310 万元收入递延至 Q4"], bullets=True, size=SIZE["body"] - 2)
add_footer(s, foot, 2)

s = add_slide(prs, "订阅收入逐季提升，硬件连续两季下滑", notes="硬件下滑与上游芯片交付周期有关。")
add_chart(s, MARGIN, Inches(1.7), CONTENT_W, Inches(4.9), ["Q1", "Q2", "Q3"],
          {"订阅": [1980, 2290, 2610], "解决方案": [1310, 1380, 1430], "硬件": [850, 830, 780]}, number_format='#,##0')
add_footer(s, foot + " · 单位：万元", 3)

s = add_slide(prs, "分业务线明细", notes=None)
add_table(s, MARGIN, Inches(1.8), CONTENT_W, [["业务线", "收入（万元）", "同比", "毛利率", "说明"],
          ["企业服务订阅", "2,610", "+21.3%", "46.2%", "续费率 94%"], ["行业解决方案", "1,430", "+8.7%", "28.5%", "两个项目延期"],
          ["硬件与外设", "780", "-6.1%", "12.9%", "芯片交付周期拉长"]], [2.9, 2.1, 1.5, 1.5, 3.9], number_cols=(1, 2, 3))
add_footer(s, foot, 4)

s = add_slide(prs, "下季度三件事", notes="每项指定负责人与时间点。")
add_text(s, MARGIN, Inches(1.8), CONTENT_W, Inches(4), ["硬件：签订两家备选供应商备货框架，交付周期压缩到 6 周内（采购，11 月底）",
         "回款：账期超 90 天的 5 家客户专人跟进（财务，11 月底复盘）", "产品：完成多组织权限与审计日志（研发，12 月中旬）"], bullets=True)
add_footer(s, foot, 5)
prs.save(out); print(out)
