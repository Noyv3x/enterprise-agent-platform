#!/usr/bin/env python3
"""Example: Chinese business report PDF. Usage: example_report.py OUT.pdf"""
import sys
sys.path.insert(0, "/opt/agent-platform/skills/builtin/pdf-documents/scripts")
from pdf_kit import *

out = sys.argv[1] if len(sys.argv) > 1 else "report.pdf"
st = styles()
W = A4[0] - 44 * mm
story = [
    Paragraph("2026 年第三季度经营分析报告", st["title"]),
    Paragraph("华东区域 · 内部资料 · 2026-10-13", st["subtitle"]),
    Paragraph("一、核心结论", st["h1"]),
    Paragraph("本季度营业收入 4,820 万元，同比增长 12.4%；毛利率 31.8%，较上季度提升 1.6 个百分点。"
              "增长主要来自企业服务订阅，硬件业务受供应链影响略有下滑。", st["body"]),
    Paragraph("二、分业务表现", st["h1"]),
    data_table([["业务线", "收入（万元）", "同比", "毛利率", "说明"],
                ["企业服务订阅", "2,610", "+21.3%", "46.2%", "续费率 94%，新增大客户 12 家"],
                ["行业解决方案", "1,430", "+8.7%", "28.5%", "两个交付项目延期至下季度确认收入"],
                ["硬件与外设", "780", "-6.1%", "12.9%", "上游芯片交付周期拉长"]],
               [W * .2, W * .17, W * .12, W * .12, W * .39], st, number_cols=(1, 2, 3)),
    Paragraph("表 1  分业务线收入与毛利率（数据来源：财务系统 2026-10-10 导出）", st["caption"]),
    Paragraph("三、风险与建议", st["h1"]),
] + [Paragraph(t, st["bullet"], bulletText="•") for t in (
    "硬件交付：与两家备选供应商签订备货框架协议，目标将交付周期压缩到 6 周内。",
    "回款：对账期超过 90 天的 5 家客户设置专人跟进，十一月底前复盘。",
    "产品：订阅业务继续投入，优先完成多组织权限与审计日志。")]
build_pdf(out, story, title="2026 年第三季度经营分析报告", author="经营分析组", header="2026 Q3 经营分析报告")
print(out)
