#!/usr/bin/env python3
"""Example: Chinese project proposal DOCX. Usage: example_proposal.py OUT.docx"""
import sys
sys.path.insert(0, "/opt/agent-platform/skills/builtin/documents/scripts")
from docx_kit import *

out = sys.argv[1] if len(sys.argv) > 1 else "proposal.docx"
doc = new_document()
sec = doc.sections[0]
add_header_text(sec, "智能客服升级项目 · 方案建议书")
add_page_number_footer(sec)
doc.core_properties.title = "智能客服升级项目方案建议书"; doc.core_properties.author = "解决方案组"

doc.add_paragraph("智能客服升级项目方案建议书", style="Title")
doc.add_paragraph("致：华东客户服务中心　　日期：2026 年 10 月 13 日　　版本：V1.0")
doc.add_heading("1  项目背景与目标", 1)
indent_body(doc.add_paragraph("当前客服中心日均咨询量约 6,200 件，人工首次响应中位时间为 9 分钟，夜间与节假日积压明显。"
                              "本项目目标是在 3 个月内将首次响应中位时间降至 1 分钟以内，并保持满意度不低于 92%。"))
doc.add_heading("2  方案概述", 1)
for t in ("知识库问答：接入 1,800 篇现有产品与政策文档，答案附出处。",
          "工单分流：按意图与紧急程度自动分派，人工只处理需判断的案件。",
          "质检看板：每日抽检 5% 会话，自动生成问题清单。"):
    doc.add_paragraph(t, style="List Bullet")
doc.add_heading("3  实施计划与报价", 1)
add_table(doc, [["阶段", "周期", "主要交付", "费用（万元）"],
                ["需求与数据梳理", "第 1–2 周", "意图清单、知识库盘点报告", "12.0"],
                ["试点上线", "第 3–8 周", "两条业务线上线、分流规则", "46.5"],
                ["全面推广与验收", "第 9–12 周", "全量上线、质检看板、验收报告", "31.5"],
                ["合计", "", "", "90.0"]],
          [4.0, 2.6, 5.6, 2.4], number_cols=(3,), caption="表 1  实施计划与报价（不含税）")
doc.add_heading("4  假设与风险", 1)
indent_body(doc.add_paragraph("报价基于客户在第 2 周前提供知识库全量导出；如数据延迟，试点周期顺延。税费按签约时适用税率另计。"))
doc.save(out); print(out)
