# 部署

本文定义系统唯一受支持的 Docker 部署方式。自动更新见[自动更新](auto-update.md)，持久目录见[数据布局](../reference/data-layout.md)，信任边界见[安全设计](../design/security-and-trust.md)。

## 唯一拓扑

宿主机只常驻 `agent-platform-manager`。Manager 作为 user-systemd 服务运行，拥有公共入口、维护页、Docker 生命周期、发布 operation、宿主执行器和本地恢复命令。Platform、Agent Runtime、Camoufox、SearXNG、Firecrawl 与按需 Agent Sandbox 全部由 Manager 按不可变镜像 digest 管理。

部署机不需要产品源码、Git working tree、Python venv、Node build 或上游源码 checkout；直接从源码启动业务服务不属于产品部署方式。只有 Manager 可以访问 Docker socket。业务容器不得挂载或代理 Docker socket。Platform backend 只发布到宿主回环，sidecar 只连接 Manager 持有的私有 bridge network。

固定服务包括：

- `platform`：Python 业务服务和已构建前端；
- `agent-runtime`：Pi 模型与工具协调器；
- `camofox`：共享浏览器服务，按 Agent 使用独立 Profile；
- `searxng` 与 Firecrawl 受管服务；
- `agent-sandbox`：按主 Agent 动态创建，不属于固定 Compose 数量。

所有权威数据都使用明确的宿主 bind mount。不得用匿名 Docker volume 保存产品数据。固定 Compose 栈使用 Manager 预先创建的 external network，generation 切换不能删除该网络或中断仍在运行的 Sandbox。

## 技术身份与安装位置

默认安装位置固定为：

```text
~/.local/bin/agent-platform-manager
~/.config/agent-platform/manager.toml
~/.config/systemd/user/agent-platform-manager.service
~/.local/share/agent-platform/
```

这里的 `~` 只能来自当前 UID 的操作系统账户记录。安装器和 Manager 忽略 ambient `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME` 与 `XDG_DATA_HOME`。control socket 唯一允许使用经安全验证的 `XDG_RUNTIME_DIR`，缺失时回退到 `/run/user/<uid>`。

这些名称是机器协议，不是品牌。管理员设置的产品名、Agent 名、Logo 与主题不能改变二进制、unit、路径、环境变量、Cookie、Compose project、网络、label、容器、数据库 marker 或 release asset。

当前代码、安装器和发布物只支持这一个技术身份与一个数据基线；没有旧路径发现、双 profile、在线命名空间交接或历史 manifest 解码分支。旧部署的数据转换属于已完成的一次性离线运维，不是产品功能，也不得重新加入普通安装、启动或更新路径。

## 全新安装

宿主需要 Linux、Docker Engine、Docker Compose v2、user-systemd，以及可使用 Docker 的部署用户。标准安装不依赖宿主 Python、Node、npm 或 Git。

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
```

安装器必须：

1. 从 HTTPS 读取当前 schema 的 release manifest；
2. 验证 Manager、Compose、镜像目录、文件名、SHA-256 和 digest 的闭世界契约；
3. 在任何安装副作用前取得单实例安装锁并确认目标是 fresh root；
4. 原子写入配置、Manager、unit 与 owner-only secret；
5. 启动 Manager，并由 Manager 执行首次 `install` operation；
6. 核心服务健康后才开放业务入口。

安装器写入 stable 的 Manager 已经与 manifest Manager 完全相同时，这是初始 Current，不创建同摘要 Candidate、Activation 或 watchdog。只有现役 Current 与候选摘要不同时才进入 Manager 自更新协议。

Manager 激活前失败只删除本次安装进程创建且身份仍匹配的对象，使同一命令可安全重试。Manager 激活后，容器 operation 由持久 journal 接管；不得重跑安装器或手工删除数据根。

## 日常管理

唯一管理入口为：

```bash
agent-platform-manager status
agent-platform-manager preflight
agent-platform-manager check
agent-platform-manager update
agent-platform-manager restart
agent-platform-manager rollback
agent-platform-manager repair
agent-platform-manager logs
```

CLI 通过 owner-only Unix socket 连接常驻 Manager。所有 mutation 带幂等键和 expected generation；同键不同请求拒绝，并发 mutation 不能取得第二个 operation owner。

Manager 的常规更新与回滚必须自行收敛，不要求操作者编辑 state、operation、activation 或 Compose。只有 Manager 因二进制启动缺陷无法稳定提供 control socket 时，才允许使用同一不可变 release 的 `recover-current`：它只替换并登记 Manager Current，不修改 Platform 数据、generation 或容器。恢复候选必须由显式 SHA-256、配置、unit、运行 inode 和当前 Platform generation 完整绑定。

## 公共入口与维护

Manager 持有所有产品监听。正常时代理 current Platform；更新、回滚或 Platform 不可用时直接返回中性维护页，因此 Platform 容器停止时入口所有权仍唯一。

默认主入口只绑定回环。管理员可显式启用受 CIDR 限制的局域网入口；推荐由局域网 TLS 反向代理连接回环入口。Manager 依据真实远端地址准入并重建转发头，不能信任客户端提供的 `Forwarded` 或 `X-Forwarded-*`。

## 发布物、启动与健康

release manifest 固定 source commit、数据库版本、Manager SHA-256、Compose SHA-256 与全部镜像 digest。Manager 不运行清单中的 shell，也不以 mutable tag 作为运行身份。部署机不拉取 Cognee、Firecrawl 或其它上游 Git 仓库。

发布冒烟只组装和验证当前 schema 的十镜像清单、八个公开资产以及单一 main 发布工作流；它不接受迁移阶段、前任清单或第二套提升协议作为输入。

Manager 先等待 Platform 与 Agent Runtime 核心 readiness，再提交 generation 并退出维护。Camoufox、SearXNG、Firecrawl 与 Cognee 是可降级能力：故障会显示并由后台有界重试，不得导致健康的 Manager/Platform 崩溃循环或长期 503。

任何时刻最多一个可写 Platform 打开 SQLite。候选先执行无业务 writer 的 preflight；停止 current writer 后再运行：

```text
enterprise-agent-platform migrate --data /var/lib/agent-platform
```

成功后才启动候选 writer。迁移和启动失败由同一 operation 使用更新前快照回滚。

Firecrawl 使用 PostgreSQL、Redis、RabbitMQ 与 Playwright；不得声明、启动或挂载 FoundationDB。SearXNG 的完整配置目录只读挂载到 `/etc/searxng`，不能依赖匿名 volume。

## Agent Sandbox

每个私人 Agent 和频道主 Agent拥有独立 Sandbox；委派子 Agent共享父 Sandbox。首次工具调用时按需创建，无任务且无后台进程达到空闲期限后停止但不删除持久目录。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与环境位于 Manager 数据根；容器可以重建，持久目录不变。entrypoint 只为 UID/GID 映射短暂使用 root，随后降权；不能递归改写挂载树。

## 验收

安装或更新至少验证：

- Manager active/enabled，且没有 active/finalize operation；
- Platform、Runtime 与公共 `/healthz` 正常；
- 登录、首页、消息、SSE 与附件可用；
- Sandbox 可按需创建、停止并保留工作区；
- terminal、搜索、浏览器和网页提取分别报告真实状态；
- Firecrawl 在保留 PostgreSQL 数据重建后仍可完成真实抓取；
- SQLite 完整性、current generation 与 Manager journal 一致。

生产故障只通过 Manager operation、当前快照和 current/previous generation 处理。不得手工编辑 journal、切换 mutable tag、直接运行 Platform 或创建第二套 Compose 栈。
