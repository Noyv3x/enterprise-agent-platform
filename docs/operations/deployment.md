# 部署

本文定义系统唯一受支持的 Docker 部署方式。自动更新见[自动更新](auto-update.md)，持久目录见[数据布局](../reference/data-layout.md)，信任边界见[安全设计](../design/security-and-trust.md)。

## 唯一支持拓扑

宿主机只常驻活动 technical profile 对应的 Manager。Manager 作为 user-systemd 服务运行，拥有公网监听、维护页、Docker 生命周期、release operation、宿主执行器和本地恢复命令。Platform、Agent Runtime、Camoufox、SearXNG、Firecrawl 及 Agent Sandbox 均由 Manager 按不可变镜像 digest 管理。

直接从 Git checkout 启动 Platform、Runtime 或集成服务不属于产品部署方式。部署机不需要产品源码、Git working tree、Python venv、Node build 或上游源码 checkout，也不存在向这些路径回退的运行分支。

只有 Manager 可以访问 Docker socket。Platform、Runtime、Sandbox 和集成容器不得挂载或代理 Docker socket。公网反向代理只连接 Manager；Platform backend 只发布到宿主回环，sidecar 只连接受管私有网络。该网络由 Manager 创建并验证，是跨 generation 保留的 external bridge network；Compose 切换不得删除它。若同名网络的 managed label、driver 或关键属性不匹配，Manager 必须拒绝接管。

固定服务栈包括：

- `platform`：Python 业务服务和已构建前端，Cognee 依赖构建在镜像中；
- `agent-runtime`：Pi 模型与工具协调器；
- `camofox`：共享浏览器服务，按 Agent 使用独立 Profile；
- `searxng` 与 Firecrawl 受管服务；
- `agent-sandbox`：按主 Agent 动态创建，不属于固定 Compose 数量。

Platform、Agent Runtime 与 Camoufox 必须以同一发布 generation 实现浏览器接管交还协议：会触发 Agent 的消息在入队前由 Platform 撤销发送者本人持有的同 scope 租约，Runtime 随后才能执行浏览器变更动作。该交还是正常服务协议，不依赖旧 generation 兼容层，也不能靠租约自然过期完成。

固定服务的持久路径必须由 Compose 显式绑定到 Manager 数据根，不能接受镜像 `VOLUME` 自动创建的匿名卷。SearXNG 必须把受管 `config/` 目录整体只读绑定到 `/etc/searxng`，而不是只覆盖其中的 `settings.yml`；候选 generation 的真实容器探针必须确认 `/etc/searxng` 是该宿主目录的只读 bind，且没有额外 volume mount。

## 宿主要求与安装位置

宿主需要 Linux、Docker Engine、Docker Compose v2、user-systemd，以及能够使用 Docker 的部署用户。标准安装不依赖宿主 Python、Node、npm 或 Git。

target-only 基线的默认位置：

```text
~/.local/bin/agent-platform-manager
~/.config/agent-platform/manager.toml
~/.config/systemd/user/agent-platform-manager.service
~/.local/share/agent-platform/
```

这里的 `~` 只能由当前 UID 在操作系统账户数据库中的唯一记录解析。fresh installer、Manager 默认 locator 和生成的 user-systemd unit 必须复用同一个账户 home 快照来派生 `~/.local/bin`、`~/.config`、`~/.config/systemd/user` 与 `~/.local/share`；忽略进程环境中的 `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME` 和 `XDG_DATA_HOME`。账户记录缺失、重复、UID 不匹配、home 非绝对路径或路径不安全时，在创建安装对象前失败关闭。这样安装位置与 Manager 后续启动解析不会因调用者环境不同而分叉。

这些名称是部署协议的技术身份，不是产品品牌。管理员设置的名称或标识图不得改变这里的路径、Manager 命令、systemd unit、Compose project、网络、容器、label、socket、环境变量、release asset 或数据库与 Sandbox identity。维护页与安装器等面向人的说明使用中性文案；运维命令仍须展示真实技术名称，不能用品牌别名掩盖实际操作对象。

旧的 source 路径只作为已完成 Bridge→Cleanup 发布编排的历史审计输入，不是当前可发现路径或长期基线：

```text
~/.local/bin/ubitech-manager
~/.config/ubitech-agent/manager.toml
~/.config/systemd/user/ubitech-agent-manager.service
~/.local/share/ubitech-agent/
```

宿主 control socket 是唯一允许读取 ambient XDG 的默认路径：使用已经验证为规范绝对路径、当前 UID 所有、非符号链接且 owner-only 的 `XDG_RUNTIME_DIR`；该变量缺失时固定回退 `/run/user/<uid>`。socket 位于其下的 `agent-platform-manager/manager.sock`。user-systemd 进程不得尝试在宿主全局 `/run` 下创建目录。该宿主目录只在运行期间存在，并绑定到容器内固定路径 `/run/agent-platform-manager/manager.sock`。已完成的 Bridge preflight 曾把该规范绝对值写入历史 journal 并供 participant、ack、listener challenge、目标配置与 Compose mount 逐字节复用；这只是历史交接证据，不是当前 source 分流能力。容器内数据根固定为 `/var/lib/agent-platform`，secret mount 根固定为 `/run/secrets/agent-platform`；Compose project 与网络分别固定为 `agent-platform`、`agent-platform_core`，环境前缀为 `AGENT_PLATFORM_*`，ownership label 前缀为 `io.agent-platform.*`，Sandbox 容器前缀为 `agent-platform-sandbox-`，内部工作目录为 `.agent-platform`。这些目标值属于发布契约，仍然不能被管理员品牌配置改变。

安装和运行 Manager 的 Unix 用户必须一致。容器内需要写用户数据的进程映射为同一 UID/GID；服务镜像需要专用 UID 时，Manager 只准备该服务明确的数据子目录，不递归改写整个数据根。

全新安装只接受当前 release 的、经过 SHA-256 验证的 Manager 工件和 release manifest。安装器执行 preflight、写入 Manager 配置与 user-systemd unit，并提交 `install` operation；产品容器只能由常驻 Manager 启动。安装不得扫描当前目录寻找可执行文件，也不得导入未知环境、Compose project 或数据目录。清单完成闭世界校验后、检查任何目标路径或产生安装副作用前，安装器必须在已验证为当前 UID 私有且无符号链接的 runtime 根上取得非阻塞单实例 flock，并持有到整个安装进程退出；竞争者必须在进入任何目标清理逻辑前明确失败。锁文件作为稳定 inode 保留，不在退出时删除；失败清理只能删除本次在持锁且确认 fresh 边界后创建的对象，不能按共享路径名删除另一安装进程的成果。

非交互安装必须显式传入 `--yes`，例如：

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
```

未传 `--yes` 时安装器只能从控制终端读取确认；没有控制终端必须明确失败，不能从承载脚本内容的标准输入读取。

Manager 激活前的安装失败必须删除本次创建的配置、二进制、unit 和 Manager 状态根，使同一全新安装命令可以安全重试；不得留下会被下一次安装误判为既有数据的半成品。Manager 已成功激活后，后续容器 operation 失败由常驻 Manager 的 journal 和恢复命令接管，安装器不得越过该所有权边界删除状态。

Manager 已激活但首次容器 operation 失败时，不得重跑安装脚本或删除数据根。修复日志指向的环境问题后，使用安装器报告的原始 manifest URL 执行 `agent-platform-manager install --config <manager.toml> --release-manifest-url <release.json>`；Manager 必须根据 journal 幂等继续或建立新 attempt。当前 target-only CLI 只接受普通 schema 2 install/update，不存在 source Manager 命令或 handoff 绕行入口。

<a id="技术命名空间交接"></a>

## Bridge→Cleanup 技术命名空间交接（历史证据）

根据 [ADR 0004](../decisions/0004-configurable-branding-and-neutral-runtime-identity.md)，source-profile、source-owner、Bridge B 与 Cleanup C 发布均已完成。以下内容保留两发布交接的受控编排与审计事实，不描述当前 Manager 的运行职责；当前系统只运行上一节固定的 `agent-platform` target-only 基线，普通启动和更新不能重新触发交接。

源、目标技术身份必须按下表精确绑定；管理员品牌设置不参与映射：

| 对象 | source identity | target identity |
|---|---|---|
| Profile | `ubitech-agent-v1` | `agent-platform-v1` |
| Manager 二进制 | `~/.local/bin/ubitech-manager` | `~/.local/bin/agent-platform-manager` |
| Manager 配置 | `~/.config/ubitech-agent/manager.toml` | `~/.config/agent-platform/manager.toml` |
| user-systemd unit | `ubitech-agent-manager.service` | `agent-platform-manager.service` |
| 宿主数据根 | `~/.local/share/ubitech-agent/` | `~/.local/share/agent-platform/` |
| control socket | `<source-data-root>/manager/control/manager.sock` | source preflight 解析出的 `<absolute-XDG-runtime-dir>/agent-platform-manager/manager.sock` |
| Manager 内部状态 / 健康路径 | `/__ubitech/status`、`/__ubitech/health` | `/__agent_platform/status`、`/__agent_platform/health` |
| 容器数据与 secret 根 | `/var/lib/ubitech-agent`、`/run/secrets/ubitech` | `/var/lib/agent-platform`、`/run/secrets/agent-platform` |
| Compose project / core network | `ubitech-agent`、`ubitech-agent_core` | `agent-platform`、`agent-platform_core` |
| 环境变量 / ownership label | `UBITECH_*`、`org.ubitech.agent.*` | `AGENT_PLATFORM_*`、`io.agent-platform.*` |
| Sandbox / 内部工作目录 | `ubitech-sandbox-*`、`.ubitech` | `agent-platform-sandbox-*`、`.agent-platform` |

历史 Bridge 发布由当时稳定运行的 source-owner Manager 唯一拥有，并以 source 二进制、unit、release asset 和数据根安全发现。source-owner release 当时只安装并演练 coordinator、owner-only handoff journal、跨重启持久 helper 和恢复入口，不创建 target unit、target root 或 target Docker 对象；Bridge release 的签名 `namespace_handoff` 描述符是该阶段唯一触发条件。它只在 Manager 为 `idle`、`maintenance=false`，且没有 active/finalize operation、Candidate、Activation、watchdog、活动 Sandbox 调用、浏览器接管或宿主执行时建立 journal。journal 绑定上表全部源与目标身份、当时 generation、桥接 artifact 摘要、数据库与 Runtime identity 摘要、初始 unit 启用状态、Docker 对象集合和每个单调阶段；这些对象现在仅是历史发布证据，Cleanup 后二进制不解析或执行它们。

历史桥接 manifest 的顶层 Manager、Compose 和镜像目录属于 target；描述符的 source 侧单独逐字节绑定直接前任公开 release，target 侧逐字段等于顶层工件。target Compose 是签名工件而不是运行时转换模板：它只接受 `AGENT_PLATFORM_*` 环境，使用 `/var/lib/agent-platform`、`/run/secrets/agent-platform`、`/run/agent-platform-manager` 与 target project/network/labels，且必须在发布前以 target Driver 真实生成的环境完成 `docker compose config` 和核心启动。保留旧资产 basename 当时只服务 source Manager 的下载发现，不允许正文继续引用 source 路径。Bridge 阶段的 Platform、Runtime、Camoufox 和 Sandbox technical-profile selector 只接受 source/target 闭集并与数据 baseline、marker 和 Manager 注入身份交叉验证；环境变量本身不能让普通 source Manager 取得 target ownership。当前 target-only 产品树不包含这些 selector。

历史桥接曾按以下顺序执行，所有文件写入都使用 owner/type/link 校验、临时文件、fsync、原子 rename 和父目录 fsync。staging 到最终目录的发布必须使用 Linux no-replace 原子 rename，目标在校验后才出现也不得被覆盖；目标已存在、内核不支持或结果不明确时均失败关闭并保留证据，重放只能接受独立完整验证过的既有目标，禁止退化为可覆盖的 rename：

1. 在关闭准入前从 live source 配置闭世界派生 target placement：目标数据根固定为 source 数据根的同级 `agent-platform` 目录，因而自定义 `data_root` 不会退回环境默认盘；目标配置同样从实际 source XDG/config binding 派生。随后验证 target 路径不存在或是本事务创建的空 staging、源与目标位于允许的同文件系统，并按源逻辑大小、已分配块和目标镜像缺失量执行容量门禁。目标数据先写入 target 同级的 owner-only、事务绑定 staging，不能直接填充最终目录。
2. 关闭业务准入，排空任务、审批、后台工具、浏览器接管和 Sandbox 调用；对 SQLite checkpoint 并建立可验证快照后停止 Platform、Runtime、Camoufox 和全部动态 Sandbox writer。writer-stop 证明必须独立枚举 Docker 的完整容器集合，逐个绑定 profile、Compose project/service、不可变镜像和精确 container id，并只在相关容器明确不存在或 `Running=false` 且 `Pid=0` 时成立；重复 service、同 project 未知容器、额外 profile writer、列表/inspect/daemon/权限/解析错误均属于 unknown 并失败关闭，不能把 health 的 `unavailable` 当作 stopped。source checkpoint 在任一 SQLite 写以前还必须按[Bridge leaf 绑定契约](../reference/data-layout.md#命名空间交接的数据变换)固定 `data/` 父目录与 `platform.db` inode，拒绝错误 owner/type/mode、符号链接和硬链接，并在 checkpoint 前后复核同一目录项；不能把 SQLite 路径 API 的剩余 TOCTOU 窗口误写为已完全消除。此后 source 数据根保持原样，作为唯一回滚证据；所有变换只发生在 target staging。
   source-owner 的 Docker evidence 只能把每个 `inspect` 结果投影为一个精确元数的 JSON 数组，并逐元素按声明类型解码；不能依赖 tab、换行或其它字符分隔字段。字符串、label 与嵌套 JSON 中的转义字符、分隔符形状和空值不得改变字段边界；无效 JSON、元素缺失或多出、尾随第二个 JSON 值及类型不符都属于不可证明的 Docker 状态并失败关闭。确定性测试必须经 `DockerCLI` 的 Runner 边界渲染 container、network 与 volume 的真实 Go-template 形态，而不能只向 reconcile 层传入预构造结构体。
3. 从签名桥接 manifest 生成 target 配置、unit、Compose 环境和全新的 target Manager 状态。target Manager 只登记 target Current、桥接回执和完成启动所需的目标 release；不得复制、路径替换或重放 source 的 operation journal、self-update journal、Candidate/Activation、recovery/takeover journal、旧 Manager binary 历史、锁、socket 或日志。source Manager 状态只作为带摘要的只读证据保留。
   目标数据目录原子发布后由持久 helper 的 `HostInstallationBoundary` 安装目标 stable Manager、目标配置和 user-systemd unit，然后才允许启动目标 participant。三者来自已验证 journal、目标工件和确定性配置生成器，不使用 shell、环境 locator 或猜测路径；首次安装与断电重放都要求 owner、mode、内容摘要和路径完全一致。生成持久 unit 时，`ExecStart` 按 systemd 命令行语法逐项引用 argv，`WorkingDirectory` 则按普通属性的绝对路径语法转义；双引号在后者会成为真实路径字符，禁止复用命令行引用器。回滚在证明全部目标 writer 停止后只删除本 transaction 精确安装的对象；提交则保留。journal、目标配置与 `target_ack` 的 control socket 必须是 source preflight 解析出的同一个规范绝对路径；任何展开、后缀匹配或双重表示都失败关闭。目标 Compose 的 `AGENT_PLATFORM_MANAGER_CONTROL_DIR` 必须取该 journal socket 的父目录，不能退回目标数据根下无消费者的 `manager/control`。
4. 把 capability secret 与应用 secret 逐个复制到 target secret 根，值保持逐字节一致，并精确保留每个文件的 owner、group 和 mode；复制前后验证 hash、类型、link count 和父目录权限，任何源权限不符合安全契约都拒绝而不是顺便“修复”。不得在交接中静默轮换 token，也不得复制 socket、lock 或临时文件。
5. 按[数据布局](../reference/data-layout.md#命名空间交接的数据变换)的白名单对数据库、Runtime/session、workspace marker、Camoufox 状态和 Sandbox registry 做结构化变换。只允许改 schema 明确声明的技术身份字段和绝对路径字段；消息、记忆、知识、提示词、邮件、文件正文、浏览器网页数据及其它用户自由文本永远不做搜索替换。staging marker 与发布 manifest 必须拒绝任意层级的重复 JSON 键；manifest 的 `resources` 必须与不可变请求按唯一资源名严格一一对应，每个资源恰好出现一次，不能用重复资源抵消遗漏资源，即使条目总数相同也必须失败关闭。
   容器专用 UID/GID 拥有且部署用户不可读的数据子树不能通过临时 `sudo`、shell、`tar` 或宿主递归 `chown` 搬运。只有声明为 `container_owned_tree + byte_exact_tree` 的闭世界资源可由 bridge release 的 digest-pinned `handoff-fs-helper` 处理；其受限 Docker 启动参数、fd-relative 路径协议、request/receipt 身份和围栏删除契约以[数据布局](../reference/data-layout.md#命名空间交接的数据变换)为准。source owner 必须在关闭准入和启动持久 helper 前按 manifest 的完整 digest 预拉取并用 RepoDigest 复验全部受管 target 镜像（固定栈、能力服务、Sandbox 与 `handoff-fs-helper`）；helper 运行时只允许本地不可变镜像，特权 worker 额外强制 `--pull=never`，因此断网恢复不会暗中取得网络能力。该镜像是 dormant handoff capability，不属于固定 Compose 栈，也不得在无 handoff journal 时启动。一次性交接 helper 使用现有公开 Platform 容器包中的独立 tag 和 digest，不创建一个需要人工切换可见性、清理发布后又成为孤立资产的新包；运行身份仍只绑定 manifest 中的完整 digest，不能依赖 tag 或包名推断内容。
6. 用 target Compose project、network、label 和容器名重建固定核心服务。不得原地 relabel、rename 或接管 source/未知 Docker 对象；target Sandbox registry 只记录已结构化验证的新身份绑定，不复制旧 container id、运行状态或临时 activity 计数，按需 Sandbox 仍在提交后首次使用时 ensure。
7. target 最终目录原子发布后，先在不开放公共写入的情况下验证 target Manager 身份、SQLite 完整性和迁移版本、权威表计数与外键、Runtime/session 引用、workspace/附件映射、Camoufox sidecar 与 Sandbox registry 的结构化身份、核心 Platform/Runtime readiness，以及 Manager 认证控制通道和自动更新 check。提交前不实际打开每个 Camoufox Profile、不启动按需 Sandbox，也不模拟真实用户登录；这些能力保留精确源快照，并在提交后按 capability/degraded 规则收敛。前述提交门全部通过后，持久 helper 把唯一 control/gateway listener 交给仍显示维护页的 target Manager，并先同步 `target_commit_planned`。从这一 checkpoint 起只能向前重试：helper 调用目标 Platform 的 transaction/generation/binding 绑定 `commit-release`，严格验证其跨重启持久 receipt，再把 receipt 与 terminal `committed` 一次写入；只有此后 target Manager 才提升完整控制面并开放业务。

浏览器状态分为两类处理。Platform 管理界面的 source 技术 Cookie 名不建立兼容读取器，也无法由服务端替用户浏览器改名；切换后用户预期执行一次重新登录，清理发布只保留 target Cookie。Camoufox 中第三方网站的 Profile、Cookie 与登录态则按原文件逐字节复制，禁止改写 Cookie 数据库或网页存储；提交门验证 sidecar、目录清单、owner/mode/mtime/hash 与 source 快照，不在交接事务内主动打开每个 Profile。提交后首次使用某个 Profile 时才执行真实打开和能力健康检查，失败只降级浏览器能力并保留 source 恢复快照供显式恢复，不能把已提交且核心健康的 target 自动回滚到 source。

在 target 提交确认以前，source stable binary、unit、配置、完整数据根、Docker 身份清单和恢复快照都不得删除，更新状态也不得报告成功。任一阶段失败时，helper 先 fence 并停止全部 target writer，只删除本事务明确创建且摘要匹配的 target unit、staging 和 Docker 对象，再从未修改的 source 根恢复 source Compose、Sandbox registry、unit 与业务入口；恢复后必须重新验证 source Manager 身份、SQLite、核心服务和 public gateway，且任意时刻最多一个 Manager 控制面和一个 Platform writer。target core network 必须在首次创建时同时写入 target profile ownership、transaction id 与 binding SHA-256 标签；崩溃重放只接受这些标签完全一致的同名 bridge。回滚必须先证明 target Manager、固定服务和 Sandbox writer 均已停止，再精确 inspect 该网络，要求无任何 endpoint/consumer，并按本次 inspect 得到的 Docker network id 删除；网络不存在视为重复回滚成功，预先存在、标签/driver/id 不可证明或仍有消费者时一律保留并失败关闭。禁止使用 `docker network prune` 或按名称删除未经事务绑定的网络。target 开放公共写入就是不可逆提交边界；越过该边界后不得自动回滚到可能已分叉的 source 数据，只能由 target Manager 的正常 operation 恢复。

清理发布只面向已经持久确认提交、target Manager 已独立完成至少一次重启与自动更新 check、且 source-owner journal 明确为 committed 的目标命名空间。它删除桥接命令、source profile 常量、源资源识别、helper 和其它一次性兼容路径，把 `agent-platform` 作为唯一基线，并在保留期后精确删除已无消费者的 source unit、配置、数据根、Docker 对象和有界恢复证据。发布证据由确定性 phase/recovery 测试逐一覆盖崩溃边界和原子回滚，由真实 user-systemd `SIGKILL` 与 Compose 实栈门验证进程及运行身份，再由唯一现役部署的签名回执确认 source-owner 或已提交 target 的实际状态；生产部署本身不执行破坏性故障注入。不能在 source-owner 尚未覆盖全部现役实例或 target 尚未确认时提前停止发布桥接资产。

Cleanup 与后续 target-baseline Manager 在没有 terminal handoff journal 时仍必须从编译期 canonical stage 选择 target profile；启动、自更新候选校验、finalize 恢复和 fresh install 使用同一个 target identity，不能调用 source 默认校验器。Bridge 二进制只有在已验证 source baseline 或 handoff journal 下使用 source；Cleanup 中不存在通过配置路径、环境或二进制 basename重新选择 source 的入口。安装器必须先读取并严格验证 release manifest：Bridge 拒绝 fresh install，schema 2 只下载中性 `agent-platform-manager-*` 工件并只创建 target 默认路径、配置和 unit。

Cleanup 不是只把 canonical stage 从 `bridge` 改成 `cleanup`。该提交还必须物理删除 Manager/Platform/Runtime 中的 source profile、handoff coordinator/helper、source asset parser 与 source inventory，并把 Python 包/CLI、进程名和 Runtime 生成契约收缩到 target 所需字段。Bridge 已在发布 target 数据根前按数据布局契约原子改写三个精确登记的机器自有设置键（会话签名 secret 与两个 Telegram secret）；Cleanup 只接受中性键，不再执行二次迁移、双读或 source 回退。全新 target 数据库从一开始只写中性键。Cognee 既有 dataset 属于第三方持久数据身份，不能搜索替换；迁移部署保留其实际内部 dataset 并只在管理接口显示中性逻辑名称，全新 target 默认使用 `agent_platform_knowledge`。这些删除和中性基线验证必须在 Cleanup 专属测试与 source 名称扫描通过后才可签发 target 回执，不能依赖入口脚本隐藏仍可调用的 source 分支。

Cleanup Manager 的生产 Go 命令树只保留 `manager/cmd/agent-platform-manager`。普通启动、更新、自更新、恢复、Sandbox 和宿主执行继续由该入口提供；`ubitech-manager`、`handoff-fs-helper`、release-transition/attestation 命令以及 handoff coordinator、participant、listener、transformer 和 source 路由包从生产树物理删除。Cleanup promotion 仍验证 Bridge 部署已经生成的签名回执，但 target Manager 不再持有签名私钥、签发新回执或解析 handoff journal；不得留下不可达命令、空壳包或按配置重新启用旧能力的分支。

## 唯一管理入口

日常运维使用：

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

CLI 通过 owner-only Unix socket 连接常驻 Manager，并从 owner-only secret 读取 control capability。Platform 使用同一 control capability 代理管理员授权的 operation；Runtime 只有独立 executor capability，不能访问管理 operation。

所有变更带 operation id、幂等键和 expected generation。Manager 先按幂等键核对不可变请求指纹，再判断 generation：同一指纹重复提交返回原 operation，相同 key 携带不同指纹则冲突。上一 attempt 明确终结后，调用方必须重新读取 generation 才能提交下一 attempt。并发请求不能启动第二个变更。

## Manager 失联恢复

只有 Manager 因已知启动缺陷持续退出、owner-only 控制 socket 无法稳定提供服务，因而普通更新和 `repair` 均不可达时，才允许使用发布二进制自带的 `recover-current` 宿主命令。该入口不是第二套平台更新器：它只替换并登记 Manager 二进制，不修改 Platform generation、operation journal、SQLite、容器或能力服务数据。

操作方先从同一个不可变 release 下载当前架构的 Manager 与 `.sha256` sidecar，核对 HTTPS 来源后把期望 SHA-256 显式传给候选二进制。命令固定要求 `--config`、`--expected-sha256` 与 `--yes`。它必须验证执行用户、配置、stable 路径、数据根、当前 Platform generation、Manager 自更新状态及文件类型；存在未归属文件、符号链接、hash 不一致或候选版本无法验证时拒绝执行。普通 activation 只有在满足下述受控接管契约时才可处理，不能通过删除字段或覆盖 stable 绕过。

Manager 状态没有 Candidate/Activation 时，恢复命令把候选复制到 owner-only 不可变版本目录，停止同一 user-systemd Manager unit，原子替换 stable 二进制并重新启动。健康检查使用经过 control capability 认证、完全不查询 Docker 或下游服务的轻量身份端点；它必须连续返回候选 release version 与当前运行可执行文件 SHA-256，并确认 systemd unit 的主进程确实来自 stable 候选，不能用可能受慢容器探针影响的完整 `/v1/status` 代替。只有这些身份检查通过后，才原子登记新的 Manager `Current`；登记时 `SourceCommit` 保持当前 Platform generation，旧 Manager `Current` 保留为 `Previous`。

若故障位于 Platform 已提交、Manager Candidate 已标记 `platform_committed`、普通 activation/watchdog 尚未提交的窗口，恢复命令只能接管一条可完整证明的 finalize 链：Platform 必须处于维护状态且没有 active operation，唯一 `finalize_pending` operation 必须是已成功但未 finalized 的 install/update，operation target、Platform Current 与 Candidate source commit 必须完全一致；Current、Candidate、Activation 与 plan 的 version、SHA、受管路径、previous path、unit、socket、token path、boot id 和时间字段必须内部一致，stable 只能匹配登记 Current 或 Candidate。若 plan 已为 `rolled_back` 而完整 Candidate/Activation 引用尚未清除，恢复命令必须在全局锁与该 plan lock 内证明 stable 已恢复 Current 及全部绑定未变，只补齐 state 清除后重新分类；不能接管或伪造这条普通回滚。任何不一致都拒绝，不能猜测。

接管先停止 Manager 主 unit，并枚举、停止该 activation 精确派生的 normal/recovery watchdog transient unit；必须证明所有相关 unit inactive、MainPID 与 ControlPID 为零、cgroup 无残留进程，且不存在仍持有同一 plan 或身份未知的同用户 watchdog 进程。出现未知同名前缀 unit、停止结果不确定或任一 journal/hash 在隔离期间改变时，必须重新分类或拒绝。确认隔离并完成二次校验后，必须在第一次修改旧 stable、plan、state 或 unit 启用状态之前持久化并同步一个确定路径的 owner-only takeover journal；它绑定 recovery version/SHA/path、Platform state 与 operation 身份及摘要、原 Manager state 身份及摘要、旧 plan 路径与原始摘要、Manager state/stable/socket/token/unit 配置、unit 初始启用状态、初始 boot id、初始 stable SHA 和事务阶段，事务摘要覆盖全部不可变绑定。旧 plan 后续内容变化不能覆盖 takeover journal 中保存的原始身份。

takeover journal 落盘后，先禁用 Manager 主 unit 的自动启动并证明其保持 disabled，再按普通 watchdog 回滚语义把 stable 恢复为登记 Current、把旧 plan 标记为受控 superseded，最后清除旧 Activation；旧 Candidate 和 plan 暂时保留为审计证据。若清除 Activation 的原子 state 写已完成、但 `activation_cleared` 阶段写尚未完成，重放只能在 journal 仍精确位于 `plan_superseded`、旧 plan 明确反向绑定同一 transaction 且 stable 精确等于登记 Current 时识别这个内部半 checkpoint；它不构成对无 journal 的 Candidate-only 外部输入兼容。进入 `activation_cleared` 后，stable 替换为 recovery 与 recovery plan/state intent 的多文件写也允许同一 journal 严格重放：stable 只能是 Current 或 journal 固化的 recovery，若 recovery plan 已存在则必须完整归属同一 transaction 且仍为 `prepared`；其它工件或身份一律失败关闭。主 unit 在恢复 plan 激活以前始终保持 fenced，因此主机在任何跨文件边界重启都不会让旧 Current 或旧 Candidate 越过事务自行启动。

随后先把 stable 原子替换为 recovery 不可变二进制，再以当前 Platform commit 建立带 `recover_current` 标记的新 activation plan。plan 绑定 takeover transaction id、recovery version/SHA/path、Platform commit、被接管 plan 的路径与原始摘要以及 journal 固化的全部 Manager 配置；新的 Candidate/Activation intent 必须在 stable 已为 recovery 后持久化，并从 recovery 不可变路径启动独立 watchdog。只有 state 已引用该 plan，且 systemd 已证明 recovery watchdog 的 PID、可执行文件、参数、cgroup 和 plan 完全匹配时，commit/rollback 及 current/previous 的唯一写权限才移交给 watchdog。外部命令此后只保留 activation bootstrap 权限，按 takeover journal 的单调阶段验证 stable、激活 plan、恢复主 unit enabled、启动 Manager；它不得直接提交或回滚，完成主 unit 启动后只能观察 watchdog 终态。跨 boot 重放必须检测当前 boot id 与 journal 固化的初始 boot id 不同，并从同一 recovery 不可变路径重新武装和证明唯一 watchdog；初始 boot id 仍是不可变事务绑定，不能通过改写 plan 形成第二个所有者。

恢复 Manager 仍走标准 pending-activation 协议，但其预提交探针只检查核心 Platform/Runtime 与公网入口，不检查 Firecrawl 等能力服务；启动确认还必须证明 systemd MainPID 执行的文件与 stable 为同一 inode。只有 recovery watchdog 经过认证身份连续确认后，才按标准切换 `Previous=旧 Current`、`Current=recovery` 并清除 Candidate/Activation。recovery watchdog 的 commit 与 rollback 都必须先条件校验 state 中的 plan path、transaction id、mode、Candidate path/SHA 仍归自己所有；失去所有权的旧 watchdog 不得写 stable、state、plan 或重启服务。

旧 activation 结算前失败保持原 state/stable；结算后任何失败统一回到登记 Current，不恢复已证明会循环的旧 Candidate，也不把失败的 recovery Candidate 留给普通 finalize 自动重激活。回滚先清空 Candidate/Activation、恢复 stable=Current、持久化 plan/journal 终态，再恢复主 unit enabled 并验证 Current 的 PID、inode、SHA 与轻量身份健康；终态写入和服务恢复之间中断时，同一命令只补做服务收敛。提交也必须在 `committed` plan/journal 落盘后幂等恢复主 unit enabled、启动登记 recovery Current 并验证其身份和 systemd 进程；主机重启后先行退出的候选不能让外部恢复只等待一个不存在的进程。若 recovery state 已原子提交为新 Current，但 plan 在终态 plan/journal 落盘前丢失或损坏，持有 takeover lock 的 watchdog 只能用最后验证的完整 plan 快照，在 state 精确匹配 recovery Current 且 stable 仍匹配 recovery SHA 时重建 `committed` plan 和 journal，不得误走回滚或再次移动 Current/Previous。恢复进程在 plan、intent、stable 替换、服务重启、watchdog 提交，或 Manager state 已提交但 Platform 已先完成 finalize 的边界中断时，同一不可变二进制和期望 hash 必须识别 `recover_current` 事务并只补齐缺失阶段，不能要求人工编辑 journal，也不能再次移动 Current/Previous。一次 recovery 已明确 `rolled_back` 后不得用同一终态 journal 暗中重开；应先诊断失败原因并使用新的已验证 recovery release 建立新事务。恢复成功后由原 `finalize_pending` 补完 reservation release，再恢复普通自动更新。

若已经提交的 recovery Current 本身健康，但旧 Platform 仍卡在该 recovery journal 精确绑定的原 `finalize_pending` operation，允许另一份经运行文件 SHA-256 校验的 `recover-current` 二进制继续接管。这个例外只适用于 Manager state 精确等于 terminal `committed` recovery checkpoint、原 Candidate 与当前 manifest artifact 逐字节相同、recovery plan 已提交、原普通 plan 仍为同一事务标记的 `superseded_by_recovery`，且 Platform operation/manifest 身份没有变化的情况；它不把健康普通 Current 变成通用旁路更新入口。新 recovery 仍执行既有停止、替换、身份探测和原子 Current 登记协议，并把已提交 recovery Current 保留为直接 Previous。随后 generation barrier 可只读消费旧 terminal recovery 证明完成原 finalize，不修改或伪造旧普通 plan。

这个接力在“旧 recovery Current 仍登记、stable 已替换为新 recovery、主 unit 已从新 inode 启动、外部命令尚未原子提交新 Current”的窗口仍必须可启动身份探针。仅当全局 recovery lock 确认由外部命令持有、旧 state 精确匹配 terminal `committed` journal、stable 与 `/proc/self/exe` 同一 SHA，且该 SHA 对应 `versions/recovery-<sha>/` 中同版本、同摘要的完整不可变工件和 metadata 时，启动门才返回 `external_recovery_probe`。该例外不适用于空闲锁、`rolled_back` journal、普通启动或不完整工件；探针仍只开放认证 `/v1/identity`，外部命令提交 state 并释放锁后才可按正常门禁晋升。

Manager 主进程每次启动都必须在构造会创建宿主布局或 journal 的 application、处理 pending activation、恢复 operation、确认候选或绑定任何监听之前执行 recovery 所有权门禁。门禁以非阻塞方式取得全局 recovery flock，不能排队到所有权边界已变后继续；空闲锁一旦取得，必须作为 startup lease 跨越 application 构造、listener 建立和 pending activation 结算，并在每个边界重新验证后才释放，避免新的 `recover-current` 插入检查与副作用之间。持锁检查必须从 owner-only、非符号链接的状态根安全枚举 `recoveries/`；目录、journal 或配置对象的类型/owner 不安全，JSON 损坏，出现未知工件、多于一条非终态 journal，或 journal 与当前 state/stable/socket/token/unit 配置绑定不一致时全部失败关闭。已完整验证绑定和终态事实的 `committed`/`rolled_back` journal 可作为历史审计记录；后续合法 Current 可以替代 live transaction，且清理策略可删除旧 version、Platform operation 和 manifest 工件，但保留的 journal、recovery plan 与 superseded plan 本身仍须完整绑定。终态 superseded plan 若缺少 `candidate_path`、`platform_commit` 或两者同时缺少，必须视为不可验证的身份篡改并在零状态写入下拒绝启动，不能根据其它 journal 字段补全或推断。

每个 `serve` 进程还必须在 application 构造前非阻塞取得 Manager binary root 内 owner-only 的 `serve.lock`，并持有到整个 HTTP、gateway、后台恢复和宿主进程生命周期结束。该锁文件必须用 `O_NOFOLLOW | O_CLOEXEC` 打开，验证为当前 UID 所有、权限不宽于 `0600` 的普通文件；状态根必须是当前 UID 所有、非符号链接且权限不宽于 `0700` 的目录。全新安装若尚无 binary root，只允许先验证既有 state root 为同 UID、无符号链接且不可被其它身份写入，再把其权限收紧为 `0700`，随后安全创建 binary root 和锁文件；不得顺带构造其它布局，也不得“修复”owner、类型或路径不安全的根。锁顺序固定为 `serve.lock → recovery.lock → activation plan lock`；第二个普通 serve 必须立即拒绝，不能借用 `external_recovery_probe` 晋升。外部 `recover-current` 不取 `serve.lock`：它停止旧服务后，新 recovery 进程先取得 `serve.lock`，再在仍被外部命令持有的 recovery lock 下进入身份探针，因此不会与正常单实例门互相等待。

无 takeover journal 的普通 Candidate-only 不是通用兼容入口。`platform_committed=false` 时仅允许当前 Platform state、唯一未完成 install/update operation、Platform Candidate、不可变 manifest 和 Manager Candidate 精确证明同一 Prepare owner，stable 与运行 inode 仍必须是登记 Current，且同 source plan 不得已存在；`platform_committed=true` 时必须改由唯一 finalize-pending Platform Current/operation/manifest 证据证明 Prepare→MarkPlatformCommitted→Activate 的耐久窗口，若 plan 已存在只能是同一绑定的 `prepared`。ownerless、终态 plan 或任何部分绑定全部拒绝。普通 watchdog 先写 `rolled_back` plan、后清除完整 Candidate/Activation 的半 checkpoint只在 plan 错误证据、全部引用、不可变 C/X 工件和 stable/running=Current 精确一致时允许进入 pending acknowledgement 补清 state；无 Activation 的终态 Candidate 仍拒绝。相反，watchdog 已先原子提升 Current、但 acknowledged plan 尚未 terminalize 的 commit 半 checkpoint，只在 Current/Previous、plan、manifest identity、stable 与运行 inode完整匹配时允许启动，随后由 Platform generation barrier 将 plan 改为 `committed`。

唯一非终态 takeover journal 在 `watchdog_owned` 之前一律拒绝主进程，使外部 `recover-current` 继续持有更改权；达到 `watchdog_owned` 后，仅当 recovery plan、journal、Manager state 与 stable 的 transaction、mode、path、version、SHA 和 phase checkpoint 精确一致时才允许 recovery Candidate 执行完整 pending-activation 协议。主机重启后全局锁空闲的同一 Candidate 必须在 startup lease 下继续 acknowledgement/watchdog 结算；若外部 `recover-current` 仍持全局锁，它已经转移给 watchdog 的精确 Candidate同样必须执行 acknowledgement，不得误降级为只读探针。对应 journal mutation flock 只能非阻塞取得；正被外部持锁者短暂占用时，只能用前后完全相同的安全快照证明同一事务，不能等待形成 systemd 启动与外部探测死锁。

没有非终态 journal、但外部全局锁正在启动 recovery R 或恢复 Current C 以做健康探测时，启动进程进入独立的 `external_recovery_probe` 模式：只读取 owner-only control capability并开放认证的 `/v1/identity`，不得构造完整 application、开放 executor/status/operation 路由、启动 gateway、恢复 operation 或后台任务。锁仍被持有时只保持身份服务；锁释放后必须在新取得的全局 lease 下证明 `/proc/self/exe`、stable 与已原子登记且无 Candidate/Activation 的 Current 完全一致，才可关闭探针 server 并进入完整启动。若外部进程在登记 Current 前死亡、锁释放时仍是旧 Current，探针进程必须立即退出，不能作为未登记 recovery 长期运行。任何其它锁冲突或不可证明边界都必须在零状态写入、零完整 socket 服务下退出，由外部恢复收敛。

control socket 绑定不能删除仍可连接的旧监听。同一 socket 路径必须先取得持久 sibling bind lock（`<socket>.lock`）：从已验证的 owner-only control 目录 fd 使用 `openat(O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600)` 打开，验证路径视图与 fd 是同一 device/inode、当前 UID 所有、权限不宽于 `0600`、`nlink=1` 的普通文件，再以非阻塞 flock 独占。该锁文件不删除，崩溃靠 fd 自动释放；listener 从任何 probe/unlink/bind 之前一直持有到自身 socket 已 unlink、监听 fd 已关闭之后才释放，因此即使不同 Manager binary root 被误配到同一 `socket_path`，也不能同时基于同一 stale inode 做决定。锁繁忙、symlink、hardlink、宽权限、owner/type/inode 异常全部失败关闭。

取得 bind lock 后，若 socket 路径已存在，Manager 必须先验证它仍是同 UID 的 Unix socket，再执行有界本地连接探测；连接成功表示 live owner 并失败关闭，超时、权限错误、路径变化及其它模糊结果同样不能删除。只有明确返回 `ECONNREFUSED` 才可视为 stale，并且 unlink 前必须重新 `lstat`，证明 device/inode、类型和 owner 与探测对象完全相同；任一 inode swap 都拒绝。listener 必须独占 unlink-on-close 所需的路径身份，外层关闭逻辑不得在 `Close` 后按字符串再次删除 socket，以免前任删除继任者刚绑定的新 inode。pending Candidate 虽需先建立身份探针供 watchdog 检查，但在 `AcknowledgeStartup` 和 `AwaitStartupCommit` 都成功以前，control handler 只允许 control capability 认证的 `/v1/identity`；`/v1/status`、executor 和所有 mutation 均关闭。提交后通过原子 handler 切换开放完整 API，不能并发修改共享布尔值形成数据竞态。

受控接管使用以下单调阶段；每次阶段更新都在对应副作用已经原子落盘并同步后发生，重放时先检查副作用再补记阶段，不能重复执行未经所有权校验的写操作。

| Takeover phase | 写权限所有者 | 已持久化事实 | 中断后的唯一合法收敛 |
|---|---|---|---|
| `prepared` | 外部恢复命令 | takeover journal 已绑定全部原始 journal、plan、manifest、operation、Manager 配置、unit 初始状态与 hash | 禁用主 unit 自动启动、重新隔离旧 unit 并验证原始证据，尚不可改旧状态 |
| `stable_current` | 外部恢复命令 | 主 unit 已 fenced；stable 已恢复并验证为登记 Current | 继续标记旧 plan；不得恢复旧 Candidate |
| `plan_superseded` | 外部恢复命令 | 旧 plan 已终态化并反向绑定 takeover transaction | 清除旧 Activation；原始 plan SHA 仍取自 takeover journal |
| `activation_cleared` | 外部恢复命令 | 旧 Activation 已清除，旧 Candidate 身份已保存在 takeover journal，主 unit 仍 fenced | 先把 stable 替换为 recovery，再建立或重放 recovery intent |
| `recovery_intent_persisted` | 外部恢复命令 | stable 已验证为 recovery；recovery plan、Candidate 与 Activation 已绑定，主 unit 仍 fenced | 启动并证明 recovery watchdog；中断时不得启动旧 Current |
| `watchdog_owned` | watchdog 独占 commit/rollback；外部命令仅保留 bootstrap 权限 | recovery watchdog 的 PID、可执行文件、参数、cgroup、plan 与 transaction 已证明 | 外部命令只可继续验证 stable、激活 plan、恢复 unit 并启动 main，任何失败由 watchdog 回滚 |
| `stable_replaced` | 同上 | 对 intent 阶段已完成的 stable=recovery 做了幂等验证并补记 | 标记 plan activated；watchdog 超时则恢复登记 Current |
| `plan_activated` | 同上 | recovery plan 已允许候选确认 | 启动 Manager 主 unit；watchdog 仍是唯一回滚者 |
| `main_started` | watchdog；外部命令只读观察 | Manager 主 unit 已恢复 enabled 并启动，等待同 inode 确认和身份连续探测 | watchdog 条件式 commit 或条件式 rollback |
| `committed` | 当前 Manager | `Previous=原 Current`、`Current=recovery`，Candidate/Activation 已清除 | 补记 plan/journal 终态并继续原 finalize，不可再次移动 Previous |
| `rolled_back` | 登记 Current | stable 已恢复 Current，Candidate/Activation 已清除，失败 recovery 身份由审计 journal 保留，主 unit 已恢复 enabled | 幂等启动并验证 Current 控制面；不得自动重激活失败候选或伪报成功 |

## 公网入口与维护

Manager 持有所有产品监听。默认主入口只绑定回环；管理员可在管理面板显式开启受 CIDR 限制、使用独立端口的第二个局域网入口，且推荐局域网 TLS 反向代理继续连接回环主入口。LAN 配置热收敛不重启 Platform；绑定失败时必须保持主入口工作并向管理员报告。Manager 以真实远端地址判断直连准入并清洗 forwarded headers，不能把通配 bind 地址当成公共 URL。正常时代理 current Platform generation；维护或 Platform 不可用时直接返回临时页面和精简更新状态，所以应用容器未启动时入口仍然可用。

维护页只展示公开 state、phase、重试时间和 support/operation id，并使用无脚本的短周期刷新。日志、宿主路径、镜像凭据、Docker 信息和恢复动作不能进入公共页面。正常管理面板通过 Platform 代理 Manager 状态；Platform 故障时使用宿主 CLI。

## 镜像与发布物

main 质量门构建受支持架构的镜像与 Manager 二进制。release manifest 包含 source commit、协议版本、数据库版本、Manager 校验和、Compose 摘要及每个镜像的完整 registry digest。Manager 只按 digest 拉取，不使用 mutable tag 作为运行身份。Platform 与 Agent Runtime 的各架构压缩层总量和本地展开尺寸还必须不超过同一提交 [`container-platform.json`](../contracts/container-platform.json) 的容量上限；该上限供部署机按“本地缺失 digest”计算更新空间，不是可由部署端放宽的设置。

官方清单引用的 Platform、Runtime、Camoufox 和 Sandbox package 必须能够在无 registry 登录状态下按 digest 拉取。CI 使用隔离的匿名 Docker 配置验证这一点，再执行 Compose smoke test；必需工件全部通过后才发布清单。

部署机不拉取 Cognee 或 Firecrawl Git 源码。Cognee 在镜像构建阶段从精确契约 revision 安装；Firecrawl Compose 服务和 digest 在 CI 中对上游契约验证后进入发布清单。

托管集成的 bind mount 只能覆盖镜像声明的数据路径，不能遮蔽 entrypoint、脚本、库或默认配置。Firecrawl 固定注入 `NUQ_BACKEND=pg`，Postgres、Redis 与 RabbitMQ 分别使用明确的宿主 bind 数据目录；部署环境不能覆盖队列后端。不得注入 `FDB_CLUSTER_FILE`、启动 FoundationDB、声明其镜像或数据目录，或让 API 等待实验性 FoundationDB 后端。

## 健康与提交

Platform generation 的核心提交门为：Manager 存活并持有公网入口与控制接口、Platform readiness 和 Agent Runtime readiness。核心门通过后可以提交 generation 并退出维护；Camoufox、SearXNG、Firecrawl 与 Cognee 的状态独立显示为 healthy、starting 或 degraded，任何单项故障都不能让 Manager 退出或把健康的 Platform 锁成 503。

Manager 启动固定栈时先等待核心服务，再异步收敛能力服务。Firecrawl 收敛以 `docker compose up --detach --wait firecrawl-api` 幂等启动 Playwright、Redis、RabbitMQ、Postgres 与 API；失败后记录有界诊断并指数退避，不自行删除或改写持久数据。该预算只约束 Firecrawl 能力收敛，不是更新维护时间或 Agent run 执行超时。

任何时刻最多一个可写 Platform 打开 SQLite。候选镜像先运行无业务 writer 的 preflight；Manager 在维护门关闭并停止 current writer 后，使用同一 Platform 镜像执行：

```text
enterprise-agent-platform migrate --data /var/lib/agent-platform
```

该命令只执行幂等 schema migration 并输出最高 migration version，不启动 HTTP、Runtime、后台 worker 或 bootstrap 用户。成功退出后才能启动候选 Platform writer。

Platform 固定容器的启动命令只使用 `serve --host <host> --port <port> --data <dir>`。`--listen-host`、`--listen-port` 或其它隐藏监听别名不属于当前接口，必须失败而不是兼容解析。

## Agent Sandbox

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器；委派子 Agent共享父容器和工作区。Sandbox 第一次执行工具时按需创建，无任务且无后台进程达到契约空闲时间后停止但不删除。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与专用环境位于数据根；容器可以重建，持久目录不变。target scope 的附件目录只读挂载到 `/workspace/.agent-platform/attachments`，不得暴露全局附件根；Bridge source 只在交接前使用 source profile 对应的 `.ubitech` 逻辑目录。容器 writable layer 与系统包安装不属于持久数据。

Manager 对宿主挂载逐级使用已验证数据根和无符号链接路径检查。首次登记后，`sandbox_id` 不能重绑到不同 `workspace_id`；registry 原子写入失败时必须撤销本次容器创建、启动或镜像替换，不能留下未登记容器。

Sandbox entrypoint 只允许在启动映射 UID/GID 时短暂以 root 运行，随后立即降权为部署用户对应身份。它不得递归修改挂载树，也不提供 root 业务进程。Manager 每次 exec 都显式使用相同 UID/GID。

## 运维验收

部署或更新完成后至少验证：

- Manager service 为 active/enabled，`status` 没有 active/finalize operation；
- Platform 与 Runtime 核心探针健康；
- 登录、首页、普通消息、SSE 与附件可用；
- Agent Sandbox 能按需创建、停止并保留工作区；
- terminal 路径可用；搜索、浏览器和网页提取分别报告实际能力状态，故障时不影响普通消息与 Agent Runtime；
- Firecrawl 在空数据首次启动与保留 PostgreSQL 数据重建两种场景均健康，并通过真实提取请求；若暂时 degraded，Manager 保持在线并继续有界自愈；
- 数据库完整性检查通过，current generation 与 Manager journal 一致。

生产故障只能通过 Manager operation、当前数据库快照和 current/previous generation 处理。不得手工编辑 journal、切换镜像 tag、直接运行 Platform 或创建第二套 Compose 栈。
