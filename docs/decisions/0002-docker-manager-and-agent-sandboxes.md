# 0002：Docker 管理平面与 Agent Sandbox

- 状态：accepted
- 日期：2026-07-24

## 背景

旧部署直接运行 Git checkout，并由产品进程执行 fast-forward、venv/Node 构建、Gateway reload 和 rollback。数据默认位于源码目录，外部集成又混合宿主进程与 Compose，使部署机工作树、更新状态和运行状态互相耦合。

成员彼此可信，但 Agent 需要各自可安装环境的工作空间；少数任务又确实需要访问 U 盘等宿主资源。

## 决定

使用宿主机 user-systemd 管理器作为稳定控制平面，所有产品与集成服务使用不可变 Docker 镜像。管理器持有公网入口、维护页、Docker socket、更新/回滚和宿主执行器；应用容器不管理其它容器。

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器，子 Agent共享父容器。默认工具只在 Sandbox 执行。模型可以为单次 terminal、文件或进程调用声明宿主目标；该申请不等待用户审批，以部署用户身份执行并允许其现有免密 sudo，同时在执行前记录完整审计。

因此 Sandbox 是默认运行环境与防误操作隔离，不是对恶意 Agent、恶意提示词或恶意成员的安全边界。

## 后果

- 部署机不再需要产品源码、Git 工作树、Python venv 或 Node build；
- 更新由镜像 digest 和数据库快照回滚，不再由 Git reset 回滚；
- 工作区、HOME 和环境目录成为显式 bind mount，可独立备份；
- Docker socket 只暴露给管理器；
- 宿主执行带来等同部署用户（包括免密 sudo）的风险，审计不能替代权限隔离；
- 基础镜像升级会丢弃 Sandbox 系统层修改，持久环境必须位于挂载目录。

## 替代方案

继续共享宿主 Runtime 无法提供每 Agent 环境隔离；给应用容器挂载 Docker socket 会混淆业务与编排边界；让 Sandbox 通过特权挂载模拟宿主机会扩大所有普通调用的权限。以上方案均不采用。
