# 部署

本文定义 ubitech agent 唯一受支持的 Docker 部署方式。自动更新见[自动更新](auto-update.md)，持久目录见[数据布局](../reference/data-layout.md)，信任边界见[安全设计](../design/security-and-trust.md)。

## 唯一支持拓扑

宿主机只常驻 `ubitech-manager`。Manager 作为 user-systemd 服务运行，拥有公网监听、维护页、Docker 生命周期、release operation、宿主执行器和本地恢复命令。Platform、Agent Runtime、Camoufox、SearXNG、Firecrawl 及 Agent Sandbox 均由 Manager 按不可变镜像 digest 管理。

直接从 Git checkout 启动 Platform、Runtime 或集成服务不属于产品部署方式。部署机不需要产品源码、Git working tree、Python venv、Node build 或上游源码 checkout，也不存在向这些路径回退的运行分支。

只有 Manager 可以访问 Docker socket。Platform、Runtime、Sandbox 和集成容器不得挂载或代理 Docker socket。公网反向代理只连接 Manager；Platform backend 只发布到宿主回环，sidecar 只连接受管私有网络。该网络由 Manager 创建并验证，是跨 generation 保留的 external bridge network；Compose 切换不得删除它。若同名网络的 managed label、driver 或关键属性不匹配，Manager 必须拒绝接管。

固定服务栈包括：

- `platform`：Python 业务服务和已构建前端，Cognee 依赖构建在镜像中；
- `agent-runtime`：Pi 模型与工具协调器；
- `camofox`：共享浏览器服务，按 Agent 使用独立 Profile；
- `searxng` 与 Firecrawl 受管服务；
- `agent-sandbox`：按主 Agent 动态创建，不属于固定 Compose 数量。

## 宿主要求与安装位置

宿主需要 Linux、Docker Engine、Docker Compose v2、user-systemd，以及能够使用 Docker 的部署用户。标准安装不依赖宿主 Python、Node、npm 或 Git。

默认位置：

```text
~/.local/bin/ubitech-manager
~/.config/ubitech-agent/manager.toml
~/.config/systemd/user/ubitech-agent-manager.service
~/.local/share/ubitech-agent/
```

安装和运行 Manager 的 Unix 用户必须一致。容器内需要写用户数据的进程映射为同一 UID/GID；服务镜像需要专用 UID 时，Manager 只准备该服务明确的数据子目录，不递归改写整个数据根。

全新安装只接受当前 release 的、经过 SHA-256 验证的 Manager 工件和 release manifest。安装器执行 preflight、写入 Manager 配置与 user-systemd unit，并提交 `install` operation；产品容器只能由常驻 Manager 启动。安装不得扫描当前目录寻找可执行文件，也不得导入未知环境、Compose project 或数据目录。

非交互安装必须显式传入 `--yes`，例如：

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
```

未传 `--yes` 时安装器只能从控制终端读取确认；没有控制终端必须明确失败，不能从承载脚本内容的标准输入读取。

Manager 激活前的安装失败必须删除本次创建的配置、二进制、unit 和 Manager 状态根，使同一全新安装命令可以安全重试；不得留下会被下一次安装误判为既有数据的半成品。Manager 已成功激活后，后续容器 operation 失败由常驻 Manager 的 journal 和恢复命令接管，安装器不得越过该所有权边界删除状态。

Manager 已激活但首次容器 operation 失败时，不得重跑安装脚本或删除数据根。修复日志指向的环境问题后，使用安装器报告的原始 manifest URL 执行 `ubitech-manager install --config <manager.toml> --release-manifest-url <release.json>`；Manager 必须根据 journal 幂等继续或建立新 attempt。

## 唯一管理入口

日常运维使用：

```bash
ubitech-manager status
ubitech-manager preflight
ubitech-manager check
ubitech-manager update
ubitech-manager restart
ubitech-manager rollback
ubitech-manager repair
ubitech-manager logs
```

CLI 通过 owner-only Unix socket 连接常驻 Manager，并从 owner-only secret 读取 control capability。Platform 使用同一 control capability 代理管理员授权的 operation；Runtime 只有独立 executor capability，不能访问管理 operation。

所有变更带 operation id、幂等键和 expected generation。Manager 先按幂等键核对不可变请求指纹，再判断 generation：同一指纹重复提交返回原 operation，相同 key 携带不同指纹则冲突。上一 attempt 明确终结后，调用方必须重新读取 generation 才能提交下一 attempt。并发请求不能启动第二个变更。

## 公网入口与维护

Manager 持有唯一产品端口。正常时代理 current Platform generation；维护或 Platform 不可用时直接返回临时页面和精简更新状态，所以应用容器未启动时入口仍然可用。

维护页只展示公开 state、phase、重试时间和 support/operation id，并使用无脚本的短周期刷新。日志、宿主路径、镜像凭据、Docker 信息和恢复动作不能进入公共页面。正常管理面板通过 Platform 代理 Manager 状态；Platform 故障时使用宿主 CLI。

## 镜像与发布物

main 质量门构建受支持架构的镜像与 Manager 二进制。release manifest 包含 source commit、协议版本、数据库版本、Manager 校验和、Compose 摘要及每个镜像的完整 registry digest。Manager 只按 digest 拉取，不使用 mutable tag 作为运行身份。

官方清单引用的 Platform、Runtime、Camoufox 和 Sandbox package 必须能够在无 registry 登录状态下按 digest 拉取。CI 使用隔离的匿名 Docker 配置验证这一点，再执行 Compose smoke test；必需工件全部通过后才发布清单。

部署机不拉取 Cognee 或 Firecrawl Git 源码。Cognee 在镜像构建阶段从精确契约 revision 安装；Firecrawl Compose 服务和 digest 在 CI 中对上游契约验证后进入发布清单。

托管集成的 bind mount 只能覆盖镜像声明的数据路径，不能遮蔽 entrypoint、脚本、库或默认配置。FoundationDB 持久数据挂载到 `/var/fdb/data`，共享 cluster 目录挂载到 `/var/fdb/cluster`；server、初始化任务和 Firecrawl API 必须使用其中同一个 `/var/fdb/cluster/fdb.cluster` 文件。

FoundationDB 初始化必须幂等：每次 `configure new single ssd` 尝试后，无论 CLI 的文本和退出码如何，都以有界 `status json` 验证 `.client.database_status.available == true`；只有该真实可用性条件成立才退出 0。不得因 `Database already exists!` 重建、清空或改写数据库。命令失败、无效 JSON、多个 JSON 文档或 database unavailable 继续有界重试并最终失败；初始化自身最多执行 20 轮、约 200 秒，Manager 对包含其它依赖和 API 健康检查的完整 Firecrawl 收敛提供 600 秒等待预算，不能把初始化预算误当成整个依赖链预算。最终诊断必须同时保留最后一次 configure 退出码/有界输出和 status 退出码/有界输出，不得只显示 `Database already exists!` 而隐去真实 readiness 失败。Firecrawl API 同时等待初始化成功和 FoundationDB 健康。

## 健康与提交

Platform generation 的核心提交门为：Manager 存活并持有入口、Platform readiness、Agent Runtime、Camoufox、SearXNG 和 Firecrawl 健康。Manager 启动固定栈时必须等待 Firecrawl 的 Playwright、Redis、RabbitMQ、Postgres、FoundationDB、一次性 init 与 API 全部收敛，Probe、恢复、管理状态和 finalize 使用同一完整目录。首次失败后只能依据容器状态做精确修复：init 已非零退出时移除该 one-shot，FoundationDB 非 healthy 时才重启原容器；API、Redis、RabbitMQ、Postgres、Playwright 或配置故障不得触发 FoundationDB 重启。完成必要修复后最多重试一次，不得删除或改写持久数据。第二次仍失败必须返回带两次原始失败摘要和各依赖状态的错误并触发 generation 回滚，不能在任一组件未就绪时静默提交更新。崩溃恢复、Manager 自更新确认和 finalize 必须重新验证六个常驻 Firecrawl 服务为 healthy、init 容器唯一且已退出 0，不能只依赖启动阶段曾经成功。后台自愈单轮上下文为 25 分钟，以覆盖两个各 600 秒的最坏启动尝试及其精确检查和清理；失败后使用指数退避，不能每分钟扰动健康依赖。该预算只约束固定服务收敛，不是 Agent run 的执行超时。Cognee 保持能力级 degraded；目标 schema 或文件迁移依赖 Cognee 时，release 必须明确提升为本次 operation 的必需服务。

任何时刻最多一个可写 Platform 打开 SQLite。候选镜像先运行无业务 writer 的 preflight；Manager 在维护门关闭并停止 current writer 后，使用同一 Platform 镜像执行：

```text
enterprise-agent-platform migrate --data /var/lib/ubitech-agent
```

该命令只执行幂等 schema migration 并输出最高 migration version，不启动 HTTP、Runtime、后台 worker 或 bootstrap 用户。成功退出后才能启动候选 Platform writer。

Platform 固定容器的启动命令只使用 `serve --host <host> --port <port> --data <dir>`。`--listen-host`、`--listen-port` 或其它隐藏监听别名不属于当前接口，必须失败而不是兼容解析。

## Agent Sandbox

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器；委派子 Agent共享父容器和工作区。Sandbox 第一次执行工具时按需创建，无任务且无后台进程达到契约空闲时间后停止但不删除。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与专用环境位于数据根；容器可以重建，持久目录不变。当前 scope 的附件目录只读挂载到 `/workspace/.ubitech/attachments`，不得暴露全局附件根。容器 writable layer 与系统包安装不属于持久数据。

Manager 对宿主挂载逐级使用已验证数据根和无符号链接路径检查。首次登记后，`sandbox_id` 不能重绑到不同 `workspace_id`；registry 原子写入失败时必须撤销本次容器创建、启动或镜像替换，不能留下未登记容器。

Sandbox entrypoint 只允许在启动映射 UID/GID 时短暂以 root 运行，随后立即降权为部署用户对应身份。它不得递归修改挂载树，也不提供 root 业务进程。Manager 每次 exec 都显式使用相同 UID/GID。

## 运维验收

部署或更新完成后至少验证：

- Manager service 为 active/enabled，`status` 没有 active/finalize operation；
- Platform、Runtime、Camoufox 与 SearXNG 核心探针健康；
- 登录、首页、普通消息、SSE 与附件可用；
- Agent Sandbox 能按需创建、停止并保留工作区；
- 搜索、浏览器和 terminal 路径可用；
- Firecrawl 在空数据首次启动与保留数据重建两种场景均完成 init，API 健康；
- 数据库完整性检查通过，current generation 与 Manager journal 一致。

生产故障只能通过 Manager operation、当前数据库快照和 current/previous generation 处理。不得手工编辑 journal、切换镜像 tag、直接运行 Platform 或创建第二套 Compose 栈。
