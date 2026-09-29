# 部署

生产环境只支持"宿主机 Manager + 受管 Docker"这一种方式。版本切换见[自动更新](auto-update.md)，路径和迁移见[数据布局](../reference/data-layout.md)，鉴权和文件边界见[安全设计](../design/security-and-trust.md)。

## 唯一拓扑

- 宿主机上只常驻一个用户级 systemd 服务 `agent-platform-manager`。桥接完成后其主进程是独立的 Manager launcher，子进程独占对外入口、维护页、Docker socket、操作管理、宿主机执行和恢复。
- Platform（含前端）、Runtime、Camoufox、SearXNG、Firecrawl 和按需创建的沙箱，都按不可变的镜像摘要管理。业务容器禁止访问或代理 Docker socket。
- Platform 后端只发布到宿主机回环地址，其它服务只在私有网络里。固定的 Compose 使用 Manager 预先创建的外部网络，切换版本时不删除网络，也不中断沙箱。
- 权威数据用显式的目录挂载，禁止匿名卷。
- 部署机不需要源码、Git、Python 虚拟环境、Node/npm 或上游源码。不支持从源码启动、第二套 Compose 栈或旧技术身份的转换。

## 全新安装

**前提**：Linux、Docker Engine、Compose v2、用户级 systemd、一个能使用 Docker 的部署用户。操作系统账户的 home 目录必须已存在、可进入、不是符号链接、属于当前 UID，并且组和其他用户不可写。`/tmp` 或 `TMPDIR` 可以是 `noexec`。精确路径和环境变量规则见[唯一根目录](../reference/data-layout.md#唯一根目录)。

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
```

| 步骤 | 做什么 |
| --- | --- |
| 验证 | 在 home 下一个随机的、只有属主可访问的临时目录里，从固定的可信来源下载当前架构的 Manager 及其 SHA-256 文件，核对文件名和摘要；运行 `inspect-release --manifest <path> --architecture <arch>` 验证完整的发布清单（包括其它架构）。这一步只输出目标地址和 SHA-256，不读配置、不开 socket、不建正式路径，也不启动服务。 |
| 锁定 | 在产生正式副作用之前取得单实例锁，并确认是全新的根目录。清单被拒绝时，在建路径之前就停止；竞争失败时，在清理目标之前就停止。 |
| 激活 | 原子写入配置、已验证的 Manager、systemd unit 和只有属主可访问的密钥，启动首次的 `install` 操作；核心服务健康后才开放入口。初始的当前版本见 [Manager 自更新](auto-update.md#manager-自更新)。 |

- 安装脚本不复制 JSON/schema 校验逻辑。自定义清单只改变下载目标，不改变初始的信任来源；本地已有相同字节就复用，否则按验证结果下载并核对摘要。
- 未验证的字节不会进入正式路径，也不增加辅助程序或资产协议。临时目录无论成功还是失败都会清理。

| 失败发生在 | 如何恢复 |
| --- | --- |
| 激活之前 | 只删除本进程创建且身份仍匹配的对象，可以重新运行同一条命令；校验失败只清理私有临时文件。 |
| 激活之后 | 由操作日志接管；用 Manager 恢复，不要重新运行安装器或手动删除数据根目录。 |

## 日常管理

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

- 命令行通过只有属主可访问的 Unix socket 通信，每次请求结束后释放连接。
- 修改类命令的幂等、版本和唯一持有者规则见[排队与维护](auto-update.md#排队与维护)。`check` 可以保存候选版本，但不会开始更新。

| 现象 | 怎么处理 |
| --- | --- |
| 等待中、空间不足、降级 | 用 `status`、`logs`、`preflight` 查看；Manager 会自动等待和重试。不要手动修改状态文件、操作日志、激活记录、Compose 或可变 tag。 |
| 提交前迁移或核心服务失败 | 同一个操作会恢复快照和上一版本，[状态机](auto-update.md#提交回滚与能力降级)会自行收敛。Platform 不可用时使用宿主机命令行。 |
| Manager 自身启动有缺陷、socket 一直连不上 | 监督模式会在有界健康检查失败后自动恢复并启动上一份已验证的 Manager，不反复切换。若上一版本也失败，停止 unit、保留数据和日志，按[手动恢复](auto-update.md#手动恢复)核验并恢复可信二进制；不手工改写预约或回滚已开放业务的数据。 |

## 公共入口与维护

- Manager 始终持有监听端口：正常时代理当前版本；更新、回滚或 Platform 不可用时显示中性的维护页。
- 默认只监听回环地址。局域网访问需要显式开启并限制 CIDR；推荐用 TLS 反向代理接到回环地址。
- 按真实的远端地址准入并重建转发头，不信任客户端发来的 `Forwarded` 或 `X-Forwarded-*`。

## 发布物、启动与健康

发布的八个资产、十个镜像以及就绪和降级规则见[更新协议](auto-update.md)。其它部署约束：

| 对象 | 约束 |
| --- | --- |
| 镜像 | Platform、Runtime、Camoufox 的 HEALTHCHECK 只在 Dockerfile 里定义，由 Compose 继承；上游服务的检查在 Compose 里声明。Platform 镜像只使用本次构建的前端产物，构建上下文排除本地的 `enterprise_agent_platform/static/`。 |
| SearXNG | 以部署 UID/GID 读写 `0600` 的 settings，`0700` 的 config 和 cache 目录；完整的 config 目录以只读方式挂载到 `/etc/searxng`。不用单文件挂载（会产生匿名卷），也不依赖上游的 root 或递归 chown。 |
| Firecrawl | 使用 PostgreSQL 队列、Redis、RabbitMQ 和 Playwright，禁止 FoundationDB；使用精确的项目标签、目录挂载和私有网络。Compose 启动后仍做 HTTP 探测；停止旧版本时移除它的受管容器。 |
| 迁移 | 不启动写入者的预检 → 停止唯一的当前写入者 → 验证快照 → 运行固定命令 → 成功后才启动候选版本。失败时由同一个操作回滚；当前/全新数据库的版本边界见[受控迁移](../reference/data-layout.md#受控迁移)，不再执行已退役的 Skill、工作区或 root 权限转换。 |

```text
enterprise-agent-platform migrate --data /var/lib/agent-platform
```

## Agent Sandbox

- 个人 AI 和每个频道主 Agent 各有独立的沙箱，委派共用父 Agent 的沙箱。首次调用时创建；没有任务和后台进程、达到空闲期限后只停止，不删除数据。
- 挂载见[数据布局](../reference/data-layout.md)。入口程序只在 UID/GID 映射阶段短暂以 root 运行，随后降权，不递归修改挂载的目录树。
- 不可变镜像预装了固定版本的 XLSX/DOCX/PPTX/PDF 生成库，以及只支持 `tools/list` 和 `tools/call` 的一次性 stdio MCP 客户端；不包含第三方 MCP 服务，不依赖临时联网或用户 HOME 里的缓存。
- 部署、重置、目录回收和停止都必须等进程、控制器和持久输出的清理屏障完成；完整规则见 Runtime 的[停止与恢复](../design/agent-runtime.md#停止与恢复)和[有限后台任务](../design/agent-runtime.md#有限后台任务)。

## 验收

- 按[部署与冒烟](../development/testing.md#部署与冒烟)执行真实的 Compose、用户级 systemd、鉴权交互和恢复门检查；静态检查和单元测试不能替代。
- 生产环境只通过 Manager 的操作、快照和当前/上一版本来恢复。
