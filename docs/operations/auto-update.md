# 自动更新

本文定义自动更新的准入、维护和回滚协议。基础部署见[部署](deployment.md)，架构背景见[系统架构](../design/system-architecture.md)。

## 目标

自动更新必须同时满足：

- 不打断正在正常推进的 Agent 任务；
- 不在消息持久化与任务入队之间切断请求；
- 更新期间禁止使用并显示统一维护页；
- 只接受可证明安全的 Git fast-forward；
- 新版本部署失败时恢复已知可用版本；
- 旧页面、旧 backend、新 backend 和 detached updater 对维护状态达成一致。

## 触发与检测

管理员可配置轮询、GitHub webhook 或手工检查。webhook 使用 secret 和 GitHub HMAC 签名；轮询线程只负责检测和发起 handoff，不自行实现部署。

检查流程读取当前 remote/branch，获取远端 revision，并验证当前 HEAD 是远端 ancestor。如果工作树有任意本地变化，更新立即跳过并报告 `working tree has local changes`；非 fast-forward 分支也拒绝更新。

检测到新 revision 后进入 `waiting_for_tasks`，保存目标 revision 和 update id。等待期间继续接受正常业务，直到一次原子的全局自然空闲点。

## 更新阻塞条件

保留更新前必须确认：

- 没有活动 Agent task；
- 没有 queued/running Agent durable job；
- 没有正在进行的消息准入窗口；
- Agent Runtime 能返回可信进程库存；
- 没有标记为 update-blocking 的受保护终端。

普通可终止后台进程单独计数，但不一定阻止更新。若 Runtime 无法证明库存、检查过程中新消息获准进入，或另一个 updater 已持有保留，本轮保留失败并继续等待。

## 原子准入保留

Python 使用同一会话锁完成最后一次 blocker 检查、写持久维护标记和设置 `_auto_update_reserved`。从该点起，新 Agent 消息在进入持久化/入队边界前收到维护响应；不存在“消息已写入但 job 未创建”的窗口。

持久标记保存在 `$DATA/auto-update-state.json`，并带 update id、目标 revision、remote、branch、phase、owner 和心跳。进程内保留从该标记恢复，因此 backend 重启不会短暂开放业务。

## 维护页与 Gateway

进入 reserving/launching/updating 后，所有业务 API 和静态应用请求都由 Gateway/Backend 统一阻断；更新状态 endpoint 保持可用。已经打开的前端通过轮询或任意 API 的 `platform_updating` 响应切换到全屏维护页，取消旧会话请求且不能继续操作。

Gateway 在 source 移动前排空活动写请求。长 SSE 等只读连接不能无限阻止代码切换；旧 backend 停止时客户端会在维护门下重连。排空、心跳、stale recovery 和重试边界由自动更新与部署配置及测试约束。

## 部署 handoff

AutoUpdateManager 在获得保留后重新检查远端和工作树，防止长时间等待期间目标失效。然后 detached 启动同一个：

```bash
./deploy.sh update
```

handoff 返回后，旧进程不再清除维护标记或释放准入；从此状态所有权属于 updater。updater 获取仓库级 flock，记录旧 HEAD，执行 fetch、fast-forward、submodule 同步和完整 bootstrap。

管理员直接在宿主机运行 `./deploy.sh update` 属于显式运维覆盖：它会获取同一仓库锁、排空 Gateway 写请求并进入维护/回滚协议，但不会等待产品层 Agent/terminal blocker。日常无人值守更新必须由 AutoUpdateManager 发起；手工命令只应在管理员已经确认任务安全或正在进行故障恢复时使用。

## 成功与失败

成功部署后，updater 原子写入 terminal success 并清除 blocking 状态。新 backend 在读取到非阻断标记后恢复 Agent worker 和产品使用；前端维护页轮询成功后重新载入应用。

失败时：

1. 如果 source 尚未移动，记录失败并安全解除维护；
2. 如果 source 已移动，确认工作树没有新本地变化；
3. 使用 `reset --keep` 回到旧 HEAD，恢复 submodule；
4. 重新部署旧版本；
5. 标记 rollback 成功或保留可诊断的失败状态。

任何信号、异常退出或维护心跳失败都进入同一保守恢复路径。自动回滚如果会覆盖并发本地变化，必须拒绝并要求人工恢复。

## 状态模型

对外稳定 `state` 包括：

- `idle`：没有等待或执行中的更新；
- `waiting_for_tasks`：已发现更新，仍允许正常使用；
- `updating`：维护已生效，正在保留、handoff、拉取、部署或恢复；
- `failed`：更新或恢复未能安全完成，继续阻断使用并等待运维修复。

`reserving`、`launching`、`pulling`、`updating`、`deploying`、`success` 与 rollback 结果属于更细的内部 `phase`，不是另一组公开 state。管理诊断快照还可以短暂返回 `checking` 或 `launching` 等控制器状态；它们同样不是持久维护准入状态。前端可以展示经清理的诊断/phase 文案，但业务准入只按公开 state 及 marker 有效性判断。

管理界面可展示 current/remote revision、dirty 摘要、Agent blockers、终端 blockers、等待时间、update id 和最近错误，但不得展示 secret 或未过滤命令环境。

`failed` 会继续阻断产品使用。运维应先保留 `$DATA/auto-update-state.json` 和部署日志用于诊断，检查 `git status --short`、当前/目标 revision 与 submodule 状态，处理阻止安全回滚的本地变化，再重新运行 `./deploy.sh update` 由持有仓库锁的 updater 接管并恢复；不要手工删除或伪造维护 marker。若源码或旧版本已无法安全部署，应从同一恢复点还原代码、submodule 与数据后再重启服务。

## 配置

主要持久设置为 enabled、interval、remote、branch 和 webhook secret。环境变量提供首次默认值，数据库设置控制运行中 listener；修改 remote/branch 会丢弃旧目标并重新检测。

Git remote 和 branch 必须通过严格名称验证，不能以 `-` 开头、包含 `..` 或控制字符。handoff 环境的 host、port、service name 和路径也必须验证，不能把数据库值直接拼接为 shell 命令。

## 测试要求

更新相关变更至少覆盖：活动/排队任务、准入竞态、受保护终端、库存查询失败、dirty tree、非 fast-forward、更新禁用竞态、Gateway 写请求排空、旧页面维护切换、成功恢复、部署失败回滚和 rollback 拒绝覆盖本地变化。
