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

人工浏览器拖拽仍沿 Platform 到 Camoufox 的私有 HTTP 服务边界执行；部署不新增 WebSocket、VNC、X display 或宿主端口。Camoufox 镜像内的锁定补丁负责 CSS 像素截图与原子 `mouse.down/move/up`，发布验收必须经过真实 Platform 鉴权链路验证该补丁，而不能直连 sidecar 代替。

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

不兼容或畸形的清单必须在创建安装路径前失败；竞争安装也必须在进入任何目标清理逻辑前失败，不能留下半安装状态。

清单解码复用 Manager 的唯一闭世界校验器，不在安装脚本维护第二份 JSON/schema 实现。安装器先验证操作系统账户 home 已存在、无符号链接组件、归当前 UID 所有且不可被组或其他用户写入，再在其中创建随机命名的 owner-only 临时目录，从自身固定的受信发布源取得当前架构 Manager 及其 SHA-256 sidecar。严格核对 sidecar 文件名与摘要后，调用无配置、无持久副作用的 `inspect-release --manifest <path> --architecture <arch>`。该命令验证整份清单（包括非当前架构工件），仅输出已验证的目标 Manager URL 和 SHA-256；不打开 control socket、不创建正式安装路径、不启动服务。临时目录在成功和失败退出时均清理；home 必须允许执行，但默认 `/tmp` 或 `TMPDIR` 可以挂载为 `noexec`，未经校验的字节不得写入正式 Manager 路径。

自定义 manifest URL 仍决定目标 release 和工件地址，不改变 bootstrap 校验器的受信来源。目标 Manager 与已验证 bootstrap 字节一致时直接复用；不同则按已验证清单下载并校验目标工件。校验失败只回收本次私有临时文件，不进入 fresh root 变更；不增加公开资产、常驻 helper 或第二套发布协议。

首次 Current 登记与不同摘要 Manager 自更新的边界见[自动更新](auto-update.md#manager-自更新)，不在安装器另建 activation 协议。

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

release manifest 固定 source commit、数据库版本、Manager SHA-256、Compose SHA-256 与全部镜像 digest。Manager 不运行清单中的 shell，也不以 mutable tag 作为运行身份。部署机不拉取 Firecrawl 或其它上游 Git 仓库。

发布冒烟只组装和验证当前 schema 的十镜像清单、八个公开资产以及单一 main 发布工作流；它不接受迁移阶段、前任清单或第二套提升协议作为输入。

发布资格与资产身份见[自动更新](auto-update.md#发布通道)，各门禁证据见[测试与验证](../development/testing.md#部署与冒烟)。不另建已退役路径或历史技术名称的源码黑名单；无消费者的历史实现直接删除。

Platform 镜像的构建上下文必须排除开发机已生成的 `enterprise_agent_platform/static/`；镜像只接受本次 frontend build stage 从受控源码生成的完整资产树，不能让本地旧 bundle 通过 Docker context 混入 wheel。

核心 readiness、提交与能力降级统一遵循[自动更新](auto-update.md#提交回滚与能力降级)；用户 workspace MCP 不进入部署 readiness。

Platform、Agent Runtime 与 Camoufox 自有镜像的健康检查只在各自 Dockerfile 定义，固定 Compose 栈直接继承镜像 HEALTHCHECK；不得在 Compose 复制同一命令和时序形成第二真源。上游镜像仍由 Compose 显式声明平台所需的健康检查。

任何时刻最多一个可写 Platform 打开 SQLite。账号集成凭据、登录失败窗口、session secret 与 `metadata.agent_work` 随同一快照、提交和回滚边界切换；更新不能清空防爆破计数，也不能让两代同时修改凭据。已持久 session secret 不因切换或重启改写，未过期／未吊销登录继续有效，TTL 与续期见[安全设计](../design/security-and-trust.md)。文档、电脑文件与 HTML 预览是按授权 scope 即时派生的有界结果，不另建表／副本，观察不创建 workspace、启动 Sandbox/Camoufox 或改写文件。容器 listen 只来自 Manager 环境与入口参数，不从 SQLite 回写。

电脑草稿只存在于当前 Run 的 Runtime→Platform 瞬态链路，不写 SQLite、消息、更新快照或 release；进程重启、generation 切换或 Run 终结即丢弃。认证 HTTP 按精确 scope/path 读正文，SSE 只公布有界 revision；不新增服务、端口、目录、配置或迁移，最终 Sandbox 原子文件取代草稿。行为见[电脑画面](../design/frontend.md#电脑画面)。

Codex 提示缓存优化同样不新增部署状态：`prompt_cache_key` 只在 Runtime 组装 provider 请求时由稳定策略、工具 schema 和当前 scope 的本地单向分片派生，不写入镜像、SQLite、session、更新快照或发布清单。进程重启后从相同可执行策略重算；供应商缓存未命中时完整请求仍按相同权限与语义执行，不得把缓存可用性纳入 readiness 或发布成功条件。

候选先执行无业务 writer 的 preflight；停止 current writer 后再运行：

```text
enterprise-agent-platform migrate --data /var/lib/agent-platform
```

成功后才启动候选 writer。迁移和启动失败由同一 operation 使用更新前快照回滚。本次基线切换只接受契约声明的直接前版本；迁移删除已退役的知识库与原生 Sylver 数据，并在完整预检后把旧 `agent-skills/<scope-hash>/<skill-id>/` 的可移植包原子复制到各 Agent workspace，把 sidecar/usage 复制到 Platform-only `agent-skill-state/<scope-hash>/`。旧 `agent-skills` 不能移动、删除或改写，因为旧 Manager 快照不包含该目录，回滚前一数据库快照后仍由旧 Platform 使用它。Sandbox 容器可跨 fixed-stack 更新保留，因此迁移发布不能把维护态当作 workspace 路径排他锁；apply、原子发布和 staging 清理必须始终相对固定且复核过的目录 fd。预检不能把所有 scope 的文件正文同时留在内存；apply 按 scope 重读源树并与预检指纹比对。文件目标全部持久化后还要再对每个受保护的 portable/state 树做最终精确复核，通过后才能提交数据库事务；事务失败留下的精确目标供原样重试，不同内容、额外项和不安全路径一律失败关闭。需要保留退役知识或原生 Sylver 数据时必须在升级前从快照或旧版本导出。

当前 baseline 的 Compose 以 root 启动同一 Platform entrypoint 并传入已验证的部署 UID/GID，使仍在运行的旧 Manager 也能消费该迁移；普通服务命令在任何数据或 secret 操作前立即降权。固定 `migrate` 先用部署身份、镜像内 isolated Python 只读确认精确 `2026080801` marker，再对旧 Docker 留下的精确 workspace mountpoint 形态执行非递归兼容，最后立即降权运行上述命令。该路径不使用额外 helper 镜像，不由 root 读取数据库或 secret，不接受任意路径/命令；fresh/current 不执行兼容，未知 marker 失败关闭。

Firecrawl 使用 PostgreSQL、Redis、RabbitMQ 与 Playwright；不得声明、启动或挂载 FoundationDB。SearXNG 的完整配置目录只读挂载到 `/etc/searxng`，不能依赖匿名 volume。

## Agent Sandbox

每个个人 AI 和频道主 Agent拥有独立 Sandbox；委派子 Agent共享父 Sandbox。首次工具调用时按需创建，无任务且无后台进程达到空闲期限后停止但不删除持久目录。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与环境位于 Manager 数据根；容器可以重建，持久目录不变。Platform 容器不挂载 Sandbox 的 `/workspace`，而是把 Agent 回复中的逻辑交付路径映射到当前 scope 的 Platform 可见工作区，并通过固定目录/文件描述符安全读取后保存附件；后台 Sandbox 进程并发替换路径时交付失败关闭。entrypoint 只为 UID/GID 映射短暂使用 root，随后降权；不能递归改写挂载树。

Sandbox 镜像预装平台文档产出 Skill 所需的固定版本 Python 库：XLSX、DOCX、PPTX 和 PDF 生成不依赖任务期间临时联网安装。它还预装平台的一次性 stdio MCP 客户端；客户端只实现 `tools/list|tools/call`，不包含第三方 server。依赖属于不可变 Sandbox generation，并由镜像构建、导入和真实文件生成/MCP 协议测试共同验收；不能把这些库装入用户持久 HOME 后再把偶然缓存当作平台能力。

Manager 对 scope family 的进程 cleanup 是部署生命周期屏障：返回确认前必须等待匹配进程退出及其控制器完成输出、进程登记与 Sandbox 活动计数落盘。更新、reset、测试目录回收和 Sandbox 停止都不能在该屏障返回后再次收到旧 wait/watch goroutine 的迟到写入。

CLI 的每次 control 请求结束后必须释放其不再复用的 HTTP transport 闲置连接；操作轮询不能为每次请求遗留一条等待服务端空闲超时回收的连接。

Manager executor 还是后台进程终态的唯一权威。`process.wait` 只在完整 execution context、精确 scope、lifecycle、target 与 process id 全部匹配时等待，并使用 Runtime 策略契约规定的默认值和上下限；等待超时或调用方取消只结束本次观察，不向进程发送终止信号，也不把 `running` 或 `orphaned` 降级成完成。自然终态与重复读取必须返回同一份有界快照，供 Runtime 解除当前 session 的有限后台任务责任。

Sandbox 后台命令的受管 wrapper 必须在自身退出前把真实 shell exit code 原子写入同一受管进程目录，Manager 的持久进程记录同时绑定该终态文件。Manager 重启后若发现 PID 已停止，只有读取到格式、类型和范围都合法的终态文件时才能恢复 `completed` 或带真实 exit code 的 `failed`；终态文件缺失、损坏、为符号链接或无法读取时必须恢复为不带伪造 exit code 的 `failed`（仍无法确认是否停止时保持 `orphaned`），绝不能因为进程当前不在运行就推断为成功。终态记录随对应进程记录的有界裁剪一起删除。

Runtime 请求清理单个 Run 时可附带由 Runtime 自身完成守卫计算的有限后台 task id 保留集合。Manager 只接受数量和格式有界、且精确属于同一 run/scope/lifecycle、当前为受管后台进程的 id；集合中任一身份不匹配都使清理失败关闭。匹配集合以外的同 Run 进程必须正常停止并等待控制器结算。普通取消、idle timeout、scope cleanup 与部署生命周期清理没有保留集合。

有限后台 task 在 Manager 中还有一个不含 session 原文的 completion owner 摘要。Manager 在进程启动前持久化 intent；Runtime 启动 Run 时以同一摘要和精确 execution context 列出尚未 acknowledge 的 task，补齐本地责任 sidecar。未 acknowledge 的 task 即使已经终止也不受普通终态 TTL/数量裁剪；Runtime 必须先把本地责任原子写成 `resolved` tombstone，再对终态 task acknowledge，Manager 确认后才能删除 tombstone。acknowledge 不接受活动进程、错误 owner、其它 scope/lifecycle/context 或任意模型参数。该持久握手只用于有限 task，前台命令和 service 不进入对账集合。

completion-required task 同时支持 Sandbox 与经过逐次审批的 host target。Sandbox task 使用 PID、输出和 exit 文件跨 Manager 重启继续观察；host 子进程按 Manager service 生命周期受控，正常终态仍保存真实 exit code，但 Manager 非正常退出或重启期间遗失控制器时必须从预提交 intent 恢复为 `failed` 且 exit code 未知，再经同一 reconciliation 交给 Runtime，不能自动重启宿主命令。这样宿主批处理不会因管理器重启重复产生副作用。

## 验收

安装、登录／消息／SSE／附件、跨客户端撤回、Sandbox 离线文档交付、真实服务、SQLite 与 generation/journal 一致性按[部署验收](../development/testing.md#部署与冒烟)执行；不能以本地静态检查替代实际服务。

生产故障只通过 Manager operation、当前快照和 current/previous generation 处理。不得手工编辑 journal、切换 mutable tag、直接运行 Platform 或创建第二套 Compose 栈。
