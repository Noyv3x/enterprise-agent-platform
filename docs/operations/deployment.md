# 部署

生产只支持宿主 Manager + 受管 Docker；[自动更新](auto-update.md)定义切换，[数据布局](../reference/data-layout.md)定义路径／迁移，[安全设计](../design/security-and-trust.md)定义鉴权／文件边界。

## 唯一拓扑

宿主只常驻 user-systemd `agent-platform-manager`，独占公共入口、维护页、Docker socket、operation、宿主执行与恢复。Platform（含前端）、Runtime、Camoufox、SearXNG、Firecrawl、按需 Sandbox 按不可变 digest 管理；业务容器禁止访问／代理 Docker socket。

Platform backend 仅宿主回环，sidecar 仅私有 bridge；固定 Compose 使用 Manager 预建 external network，切换不删网络或中断 Sandbox。权威数据显式 bind mount，禁匿名 volume。部署机不需源码、Git、Python venv、Node/npm、上游 checkout；不支持源码启动、第二 Compose 栈或旧技术身份转换。

## 全新安装

**前提：** Linux、Docker Engine、Compose v2、user-systemd、可使用 Docker 的部署用户。OS 账户 home 必须已有、可执行、无 symlink、当前 UID 所有且组／其他用户不可写；`/tmp`／`TMPDIR` 可 `noexec`。精确路径与环境变量规则见[唯一根目录](../reference/data-layout.md#唯一根目录)。

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
```

| 步骤 | 必须满足 |
| --- | --- |
| 验证 | home 随机 owner-only 临时目录中，从固定受信源取得当前架构 Manager／SHA-256 sidecar，核对文件名／摘要；运行 `inspect-release --manifest <path> --architecture <arch>` 验整份闭世界清单（含其它架构）。只输出目标 URL/SHA-256，不读配置、开 socket、建正式路径或启动服务。 |
| 锁定 | 正式副作用前取得单实例锁、确认 fresh root；清单拒绝在建路径前，竞争失败在目标清理前。 |
| 激活 | 原子写配置、已验证 Manager、unit、owner-only secret，启动首次 `install` operation；核心健康才开放入口。初始 Current 见[自更新](auto-update.md#manager-自更新)。 |

脚本不复制 JSON/schema 校验器。自定义 manifest 只改目标，不改 bootstrap 信任源；相同字节复用，否则按验证结果下载验摘要。未验证字节不进正式路径，不增 helper／资产协议；临时目录成功失败都清理。

| 失败点 | 恢复 |
| --- | --- |
| 激活前 | 只删本进程创建且身份仍匹配的对象，可重试同命令；校验失败只清私有临时文件。 |
| 激活后 | journal 接管；用 Manager 恢复，不重跑安装器／手删数据根。 |

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

CLI 走 owner-only Unix socket，请求结束释放不复用的 transport 闲置连接。mutation 的幂等／generation／唯一 owner 见[排队与维护](auto-update.md#排队与维护)；`check` 可存 Candidate，不开始更新。

| 现象 | 恢复 |
| --- | --- |
| 等待、空间不足、degraded | `status`／`logs`／`preflight`；Manager 自动等待重试，不手改 state、journal、activation、Compose 或 mutable tag。 |
| 提交前迁移／核心失败 | 同 operation 恢复快照和 Previous；[状态机](auto-update.md#提交回滚与能力降级)自行收敛。Platform 不可用时使用宿主 CLI。 |
| Manager 启动缺陷，socket 持续不可达 | 才允许同一不可变 release 的 `recover-current`；显式 SHA-256、配置、unit、运行 inode、Platform generation 完整绑定。只替换登记 Manager Current，不改 Platform 数据／generation／容器；见[恢复身份](auto-update.md#恢复身份)。 |

## 公共入口与维护

Manager 始终持有监听，正常代理 Current，更新／回滚／Platform 不可用时给中性维护页。默认回环；LAN 须显式启用、限制 CIDR，推荐 TLS 代理接回环。按真实远端准入并重建转发头，不信任客户端 `Forwarded`／`X-Forwarded-*`。

## 发布物、启动与健康

八资产／十镜像、readiness／degraded 见[更新协议](auto-update.md)。其余部署约束：

| 对象 | 约束 |
| --- | --- |
| 镜像 | Platform／Runtime／Camoufox HEALTHCHECK 只在 Dockerfile 定义，Compose 继承；上游检查由 Compose 声明。Platform 只用本次 frontend stage 资产，context 排除本地 `enterprise_agent_platform/static/`。 |
| SearXNG | 部署 UID/GID 读写 `0600` settings、`0700` config/cache；完整 config 根只读挂 `/etc/searxng`，不用单文件挂载制造匿名卷，不依赖上游 root／递归 chown。 |
| Firecrawl | PostgreSQL 队列、Redis、RabbitMQ、Playwright，禁 FoundationDB；精确 project label、bind mount、私网。Compose 后仍 HTTP 探测，停旧 generation 时移除其受管容器。 |
| 迁移 | 无 writer preflight → 停唯一 current writer → 验证快照 → 固定命令 → 成功才启候选。失败同 operation 回滚；版本资格、旧 Skill 源保护、root 例外仅见[受控迁移](../reference/data-layout.md#受控迁移)。 |

```text
enterprise-agent-platform migrate --data /var/lib/agent-platform
```

## Agent Sandbox

个人 AI／频道主 Agent 独立，委派共享父 Sandbox；首次调用创建，无任务／后台进程达到空闲期限后只停止、不删数据。挂载见[数据布局](../reference/data-layout.md)；entrypoint 仅为 UID/GID 映射短暂 root 后降权，不递归改挂载树。

不可变镜像预装固定版本 XLSX/DOCX/PPTX/PDF 生成库和仅 `tools/list|tools/call` 的一次性 stdio MCP 客户端，不含第三方 server，不依赖临时联网／用户 HOME 缓存。部署、reset、目录回收、停止必须等待进程／控制器／持久输出的 cleanup 屏障；完整契约见 Runtime [停止与恢复](../design/agent-runtime.md#停止与恢复)及[有限后台任务](../design/agent-runtime.md#有限后台任务)。

## 验收

执行[部署与冒烟](../development/testing.md#部署与冒烟)的真实 Compose、user-systemd、鉴权交互、恢复门，静态／单元不能替代。生产只通过 Manager operation、快照、Current/Previous 恢复。
