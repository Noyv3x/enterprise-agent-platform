# 架构决策记录

本目录保存影响多个模块、兼容性或长期维护方式的架构决策。当前生效设计仍以 `../design/`、`../reference/` 和 `../operations/` 为准；ADR 记录为什么选择该设计，不复制完整规范。

## 状态

- `proposed`：仍在讨论，不约束实现；
- `accepted`：已批准，必须同步到规范和代码；
- `superseded`：由新的 ADR 替代；
- `rejected`：保留讨论背景，但不实施。

## 写法

文件名使用递增编号和短横线标题，例如 `0002-host-execution-boundary.md`。内容至少包括状态、背景、决定、后果和替代方案。改变既有决定时创建新 ADR，并在两份记录中互相链接，不改写历史理由。

当前记录：

- [0001：文档是唯一设计真相源](0001-documentation-is-design-source.md)
