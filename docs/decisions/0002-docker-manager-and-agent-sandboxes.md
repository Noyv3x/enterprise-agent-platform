# 0002：Docker 管理平面与 Agent Sandbox

- 状态：superseded（宿主执行审批部分由 [0003](0003-host-execution-requires-per-call-approval.md) 取代；其余决定继续有效）
- 日期：2026-07-24

## 背景

产品需要把发布身份、更新状态、业务数据与开发工作树完全分离，并为应用容器之外的生命周期管理提供稳定控制平面。

成员彼此可信，但 Agent 需要各自可安装环境的工作空间；少数任务又确实需要访问 U 盘等宿主资源。

## 决定

使用宿主机 user-systemd 管理器作为稳定控制平面，所有产品与集成服务使用不可变 Docker 镜像。管理器持有公网入口、维护页、Docker socket、更新/回滚和宿主执行器；应用容器不管理其它容器。

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器，子 Agent共享父容器。默认工具只在 Sandbox 执行。模型可以为单次 terminal、文件或进程调用声明宿主目标；该申请不等待用户审批，以部署用户身份执行并允许其现有免密 sudo，同时在执行前记录完整审计。

因此 Sandbox 是默认运行环境与防误操作隔离，不是对恶意 Agent、恶意提示词或恶意成员的安全边界。

## 后果

- 部署机不需要产品源码、Git 工作树、Python venv 或 Node build；
- 更新只按镜像 digest 和数据库 generation 快照回滚；
- 工作区、HOME 和环境目录成为显式 bind mount，可独立备份；
- Docker socket 只暴露给管理器；
- 宿主执行带来等同部署用户（包括免密 sudo）的风险，审计不能替代权限隔离；
- 基础镜像升级会丢弃 Sandbox 系统层修改，持久环境必须位于挂载目录。

## 替代方案

继续共享宿主 Runtime 无法提供每 Agent 环境隔离；给应用容器挂载 Docker socket 会混淆业务与编排边界；让 Sandbox 通过特权挂载模拟宿主机会扩大所有普通调用的权限。以上方案均不采用。

## 后续决定

本记录中“宿主目标不等待用户审批”的决定已被 [0003：宿主执行逐次审批](0003-host-execution-requires-per-call-approval.md) 取代。本文保留当时的设计背景，不再作为当前审批行为的依据。
