# 自动更新

本文定义当前 Docker 基线的发布检测、任务排空、维护、提交和回滚协议。部署拓扑见[部署](deployment.md)，持久目录见[数据布局](../reference/data-layout.md)。

## 唯一真相源

活动 technical profile 对应的 Manager 是部署机唯一更新控制器。部署机不读取 Git remote、branch 或 working tree，也不从仓库脚本启动产品。main 通道的 release manifest 是唯一版本目录；实际运行身份由清单中的完整 Manager 校验和、Compose 内容和镜像 digest 共同确定。

CI 只有在文档门禁、Python、Runtime、前端、Manager、容器构建、上游契约与真实 Compose smoke test 全部成功后才发布清单。全部受管镜像先生成唯一的已验证 digest 目录：双架构容量门、真实 Compose 验收与最终 release manifest 必须消费这一份目录。Compose 验收在启动前逐项确认解析后的服务镜像就是将发布的 digest，不得使用另一套默认值通过验收。每个 main commit 先产生不可变 `container-<commit>` release，发布 job 在封印完成后还要上传独立 Actions 出处证明，将 repository、workflow path/event、run id/attempt、Container run 的 execution head、实际构建的 source commit、其精确成功 Quality run/attempt 和 release ID 与全部 asset ID/digest/size 绑成闭世记录。`workflow_run` 的 execution head 按 GitHub 语义可能是已经前进的 default branch，而构建 source 必须来自事件中 Quality run 的 head；发布 job 必须经 API 重证该 Quality run 的仓库、workflow、push/main、成功结论、attempt 与 head。手工 dispatch 则同时绑定原始 ref、`checkout(inputs.ref) → git rev-parse HEAD` 解析规则及同一 source 的精确成功 Quality run，不能靠输入自报合格。promotion evaluator 必须从该精确成功 Container run/attempt 的唯一 publish job 下载证明，重证 Container execution head、Quality run 和当前 release 的逐字段身份，再以证明中的 source commit 匹配候选；不得错误要求 Container execution head 等于 source，也不得用无关成功 run 唤醒另一个 draft。中断发生在封印后但证明上传前时，后续 attempt 只能在逐字节复验原 release 后为自身产生精确证明，不改写封印。main 通道再在全局 promotion 锁内只向已通过质量门的后代 commit 单调推进。较早 workflow 即使后完成，也不能改写 latest 或触发降级。发布清单必须最后出现，实例不能看到半套发布物。技术命名空间切换期间的直接前任、draft 和回执门禁只由 [`release-transition.json`](../contracts/release-transition.json) 定义，不得另建第二套 promotion 判断。

早于封印协议的首次 promotion 已经完成，当前公开直接前任具备完整 `promotion.json` 与 Actions provenance。Bridge 及其后续 evaluator 只接受完整封印的 current release；历史 P1 的特殊资产形状、摘要夹具、`source_owner_compat` 解析器和 `--current-compat-root` 入口全部退出运行路径，不再作为新基线的一部分。所有候选都必须从完整封印的直接前任单调推进。

同一次已完成升级使用的无 `--config` watchdog 启动例外和 `/v1/status.workspace_schema_commit` 一次性授权也随之退役。新基线的普通 watchdog 始终显式绑定已路由配置，Manager status 不再投影 workspace 迁移能力；当前 source 数据中仍由 Bridge transformer 验证的已登记历史库存只是输入数据契约，不得重新开启普通更新兼容入口。

Bridge B 只能以 canonical contract 固定的、已在部署机稳定运行且完整封印的最终 source-owner 为直接前任。发布图不再接受新的 source-owner 候选或同阶段稳定化分支；历史、重复或绑定其它 challenge 的 source-owner 回执不能授权 B，只有同时绑定该固定直接前任、B generation 与本次一次性 challenge 的新鲜 `source_owner_ready` 回执有效。

Manager 将 `releases/<source-commit>/` 视为不可变身份：manifest 与 Compose 先下载到同目录 staging，完整验证并同步后原子发布。相同 commit 的工件必须逐字节一致；缺件或内容漂移视为 immutable-ID collision，必须在拉取镜像和进入维护前失败。

release manifest 的镜像目录必须与 schema 对应的闭世界集合精确相等：schema 1 的 source-owner/Bridge 目录固定为十个运行镜像加一次性交接 helper，schema 2 的 Cleanup/target-only 目录固定为十个运行镜像且禁止 helper 与 `namespace_handoff`。JSON Schema、发布组装、Manager 解析器和静态验收共用这两套明确集合，不接受、保留或投影 opaque 额外镜像项；不存在按历史 generation、摘要或本地路径放宽解析的第三种兼容形状。

发布器、匿名镜像复验和资产封印必须按 canonical transition stage 选择唯一协议。Bridge 只允许 schema/protocol 1、十一镜像和 helper，并为 source 发现临时使用 `ubitech-compose.yaml` 与 `ubitech-manager-linux-{amd64,arm64}`；Cleanup 与 target baseline 只允许 schema/protocol 2、十镜像，资产名固定为中性的 `agent-platform-compose.yaml` 与 `agent-platform-manager-linux-{amd64,arm64}`，且不得构建、上传或引用 helper。两种 Manager 资产都带同 basename 的 `.sha256` sidecar，安装器与封印目录必须按 stage 精确选择，不接受混合名称。schema 2 的安装器与运行中 Manager 必须执行同一工件闭集：Manager version 精确等于 `source_commit`、架构键精确为 `amd64`/`arm64`、每个 URL basename 与中性资产名相等，Compose basename 精确为 `agent-platform-compose.yaml`，URL 不含凭据、query 或 fragment；Manager 下载并校验候选字节后还必须执行候选的只读 `version` 命令，并要求其输出逐字等于清单 version，不能只接受任意非空输出。不能出现“fresh install 会拒绝、自动更新却接受”的较弱解析器。Cleanup C 必须在 B 仍是已封印 draft、公开 latest 仍是最终 source-owner 时预构建：构建端通过 canonical `predecessor_generation` 精确读取 `container-<B>` draft 并逐字节复验其 seal、provenance 与工件，不把 public latest 冒充 C 的直接前任。promotion 时仍必须重新证明 B 已公开为 latest、C 是其唯一直接后继并具备有效 target 回执。普通 target-baseline 则只跟随当前公开 target-only latest。

Cleanup 与 target-baseline 的质量门和 release 组装门还必须运行同一独立的 target-only source-tree gate。该门从 canonical transition contract 读取 stage：Bridge 明确跳过；另两个 stage 对产品实际编译、打包和容器入口的闭世界路径集合执行扫描，要求 source profile 常量、旧技术环境变量/路径/资产名、一次性 Manager 命令、namespace handoff parser、helper/coordinator/transformer 模块和生成的 P1 inventory 已从生产树物理删除。扫描不遍历 docs、release orchestration 或第三方依赖；历史值只允许保留在 `_test`、`tests`、`testdata` 和 `scripts/tests/fixtures` 这些非产品夹具边界，数据库演进代码可以保留与用户数据有关的表/字段名，但不得借迁移名义保留任何 source technical-profile 选择器或可执行兼容入口。扫描根缺失、未知文件类型、符号链接、不可解码文本或任一命中都失败关闭；不能用 allowlist 参数在 workflow 中放宽。

普通 target-baseline 发布使用 main 通道级串行 release 队列，并在封印时把 promotion 的直接前任绑定为当时公开且已封印的 target-only latest，而不是把过渡 contract 的锚点冒充每一代永久前任。若当前 latest 已有一个密封的普通直接后继，后续发布等待该后继完成 promotion 后重新读取 latest；等待超时只失败当前尝试，不产生第二个同前任 draft。每次普通 promotion 完成后 evaluator 重新触发对最新已通过 Quality 的 main head 的 release 评估，使快速连续 push 最终自动追上 main；Bridge/Cleanup 仍保持固定 B/C 双 draft 与部署回执序列，不进入这条去抖路径。

manifest `generated_at` 由组装器接受 RFC 3339 输入后严格解析并规范化为 UTC `Z` 形式。输入必须带时区且表示有效时刻；无时区、日期替代时间、非 RFC 3339 或无效偏移一律拒绝。安装器继续只接受规范化的 `Z` 资产，不通过放宽 fresh-install 校验兼容发布器输出。

管理员品牌配置不是 release identity。产品显示名称、标识图或其它展示字段变化不创建 generation，不改变清单 URL、commit、镜像 digest、Manager 路径、Compose/Docker identity、环境变量或任何更新幂等键；更新期间也不能从品牌值推断这些字段。Platform 不可达时，Manager 使用中性维护文案，不把读取业务数据库作为控制面健康或回滚前提。

### 技术命名空间迁移发布

source-profile 基线与完整 source-owner 基线 A2 已经发布并完成前置验收；当前活动转换从 canonical contract 固定的最终 source-owner 开始。桥接发布 B 执行[技术命名空间交接](deployment.md#技术命名空间交接)，再由清理发布 C 形成连续的两发布事务。A2 是已经完成的普通发布：release manifest 保持普通形状且不携带 `namespace_handoff`；B 和 C 必须作为已封印的不可变 draft 产出。桥接与清理都不能伪装成一次普通镜像 generation 更新。桥接发布继续提供现役 Manager 能发现并校验的原技术资产，同时把签名目标固定为 `agent-platform-manager`、`agent-platform-manager.service`、`~/.config/agent-platform`、`~/.local/share/agent-platform`、`/var/lib/agent-platform`、`agent-platform`、`agent-platform_core`、`AGENT_PLATFORM_*`、`io.agent-platform.*`、`agent-platform-sandbox-*` 和 `.agent-platform`。在进入维护前它必须证明系统处于无 operation、无 activation/watchdog、无执行调用的稳定边界，并先持久化绑定源/目标全部身份的 handoff journal。其公开 operation 只有在目标 Manager 已接管、目标核心 generation 健康、自动更新轮询可达且源身份已安全退役后才能 finalize；仅复制数据、启动目标 unit 或返回健康页都不构成成功。

B 的顶层 `manager`、`compose` 与 `images` 是完整 target generation，`namespace_handoff.target` 必须与顶层 Manager/Compose 逐字段一致；`namespace_handoff.source` 则必须逐字段复用直接前任 source-owner 的公开 manifest，不能把 B 的 target Compose 同时冒充源恢复工件。为兼容 source-owner 发现，B 的 GitHub release 可以暂时保留 source 时代的资产文件名，但文件名不决定技术身份：其中 Compose 正文必须只消费 `AGENT_PLATFORM_*`，只挂载 `/var/lib/agent-platform`、`/run/secrets/agent-platform` 与 `/run/agent-platform-manager`，并使用 target project、network、label、Sandbox 和 marker。target Driver 不重写 YAML，也不得向 target 进程泄漏 `UBITECH_*` 作为隐式回退。Bridge 镜像中的 Platform、Runtime、Camoufox 与 Sandbox 入口必须用闭世界 technical-profile 绑定消费与 target Compose 相同的 data/secret/control 根；未知、混合或与已变换数据库/marker 不一致的 profile 在启动任何 writer 前失败关闭。B 公开到 C 公开之间不接受全新安装：安装器看到一次性 `namespace_handoff` 且不存在已经运行的直接前任时必须明确退出，避免创建没有 source journal 的半 target 部署。schema 2 的 C 与后续 target baseline 必须由编译期生成的 target-only stage 选择 target Manager/config/data/unit/socket；无 handoff journal 的 fresh install 也不能退回 source profile、根据二进制 basename 或环境变量猜测身份。安装器按 manifest schema 选择中性 target 工件与路径，C 恢复 target-only 全新安装。

桥接失败必须由同一 journal 回到唯一源 Manager 和原业务入口。目标状态不完整、两套 unit 同时可能启动、源/目标路径包含符号链接、Docker ownership 无法证明或任一持久摘要变化时保持维护并失败关闭。后续清理发布在确认 bridge terminal commit 后移除一次性识别与迁移实现；普通发布不得永久同时接受两套路径、unit、label、Cookie、API 或 release asset。CI 必须从上一公开基线真实执行桥接、在每个持久阶段注入终止并验证只存在一个更新所有者，再验证清理发布不能重新识别源命名空间。main 通道不得在唯一现役部署尚未写入桥接 `target_ack`、提交 `committed`、完成源退役并通过目标 Manager 认证的通道检查时把 latest 推进到只支持目标身份的 C；不能依赖轮询恰好先看到中间 release。

#### 第一发布的触发与所有权

技术切换前后使用四个连续且可独立验收的逻辑阶段。第一阶段 source-profile 已完成现役 source identity 集中与无副作用描述符拒绝边界；第二阶段 source-owner A2 已交付并接通完整 coordinator、持久 helper、journal、listener 交接、恢复和启动发现路径，但自身 release manifest 仍使用普通闭世界形状且明确不携带 `namespace_handoff`。当前固定的最终 A2 不再接受同阶段后继。只有唯一现役部署用其部署级 Ed25519 密钥对一次性 challenge 生成针对该最终 source-owner 和 B 的 `source_owner_ready` 回执，且统一 promotion evaluator 验证它正在空闲 A2 source-owner capability 上运行后，第三个不可变 draft B 才可公开并成为 latest。第四个不可变 draft C 只在同一部署签发 `target_handoff_committed` 回执，证明 B 已 `committed`、`target_ack` 与源退役证据完整，且目标 Manager 在退役后成功完成一次认证通道检查后才可公开。这样现役 Manager 不需要猜测未知字段，桥接 Candidate 也不会在普通 activation/watchdog 尚未结算时搬移自己的状态根；任一中间发布失败都保留原源身份运行。B 描述符必须同时提供现役 Manager 可读取的源 Compose/Manager 工件和目标 Manager、目标 Compose 工件，所有 URL、摘要、源/目标 identity 和 bridge generation 都属于同一不可变清单；缺少任一目标工件时只能把该发布视为不可执行，不能退回普通 update。

只有一个在 `main` 全局锁下运行的 promotion evaluator。它对普通与转换发布共用同一个当前 latest、直接前任和不可变工件判定：source-profile 与 A2 的历史边已经封闭；当前 B 的直接前任只能是 canonical 固定的最终 source-owner，C 的直接前任只能是 B。任一步都不得跳过、用更新后代替换或从另一个 workflow 改写 latest。B/C draft 在完整资产目录与摘要封印后禁止 `--clobber`、删除或替换资产；同 tag 的任何字节差异都是 immutable-ID collision。公开前同名 Git ref 必须已是直接指向 candidate commit 的 lightweight commit ref；不存在时只允许受信 evaluator 用 create-only API 建立并立即复验，错误 ref、annotated tag、传输不确定或竞争都在 visibility 变更前失败关闭。构建成功、后代 commit 更新或普通“最新合格发布”逻辑都不能自动把 B/C 变为 non-draft；只有收到当次 challenge 的有效回执后，该唯一 evaluator 才能显式公开对应的直接后继。候选 manifest 按自身 schema 声明的全部镜像 digest 在 visibility 变更紧邻前后都必须以无凭据 registry 请求复验；后验发现不可达时要明确报告“发布已可见”的高危事故，不得声称 workflow 失败已回滚 visibility。

转换发布不再依赖仓库外的 predecessor black-box harness、固定十六重启矩阵或独立 qualification artifact。Bridge 的发布证据由仓库内确定性 phase/recovery 测试、真实 user-systemd `SIGKILL` 集成门、消费同一已验证镜像目录的 Compose 实栈冒烟，以及唯一部署机签署的 challenge-bound 回执共同构成。确定性测试逐阶段验证 journal/state 双文件边界、listener 转交、单一 Manager/listener/Platform writer、forward-only commit 和原子 source rollback；systemd 门证明持久 helper/Manager 被真实 unit 恢复且没有并行旧进程；Compose 门验证 target Manager、Compose、镜像、持久数据和运行身份；部署回执把候选、直接前任、实际运行 Manager 摘要与权威 handoff 状态绑定。publisher 的普通 Actions provenance 仍闭世界绑定本次 source commit、Quality run 和 sealed release 资产，promotion evaluator 仍重证这些身份；它不能用日志文字或手填布尔值替代任一门。唯一生产部署不执行破坏性故障注入，只通过 owner-only CLI 对当次 challenge 产生 `source_owner_ready` 或 `target_handoff_committed` 签名回执。

promotion evaluator 先为精确的“回执类型 + 直接前任 + draft generation”生成一次性随机 challenge。部署只能用预先登记且唯一的部署级 Ed25519 私钥签名 RFC 8785 规范 JSON；evaluator 使用受保护环境中锁定的唯一公钥验证 deployment id、key id、challenge id/nonce、类型、前任、候选 generation、本地观测 generation、证据摘要与时间窗口，并对 challenge 一次性消费防止重放。私钥、challenge 和回执保存于已展开的 `$XDG_STATE_HOME/agent-platform/release-transition`，该根必须是 owner-only、无符号链接的真实目录，且在词法和已挂载物理身份上均不得位于 source/target 数据根内或包含任一数据根。回执不是 handoff journal，不能由 CI 自签、从日志文字推断或在迁移数据时顺带生成。

challenge 与 receipt 分别严格服从 [`release-transition-challenge.schema.json`](../contracts/release-transition-challenge.schema.json) 和 [`release-transition-receipt.schema.json`](../contracts/release-transition-receipt.schema.json)，未知字段一律拒绝。标准流程不开放网络 attestation API：序列化 promotion workflow 生成 challenge 作为认证 Actions artifact；操作者把文件送入部署机 owner-only CLI，由该短生命周期宿主进程直接读取部署证明密钥，并通过 owner control socket取得不含密钥的权威 journal、运行状态、架构与运行 Manager 摘要观测，最后在本地生成 receipt 和独立的标准 base64 Ed25519 签名。长期运行的 Manager control API 及其 Platform capability 只可在认证的 `POST /v1/release-transition/observation` 提供这个只读、无机密的 challenge-bound observation，不能初始化、读取、持有或调用私钥，也不能返回签名；`/identity` 与 `/attest` 形式的转换路由不存在。随后 workflow dispatch 只接收原 challenge run id、base64 receipt 与签名。`source_owner_ready` 必须观测空闲的 source-owner A2，`target_handoff_committed` 必须观测 B 的 target-owner、terminal `committed` 与完整证据摘要。CI 必须把 challenge 全字段逐项绑定到回执，并验证候选直接前任 release 对应架构的 Manager SHA；只相信部署上送的字符串或日志不构成证明。

部署身份只由上述 owner-only 宿主 CLI 在中立状态根内初始化和读取；标准命令为 `ubitech-manager release-transition identity --config <absolute-manager.toml> --public-key-pem <new-absolute-pem>`。PEM 文件以 `0600`、禁止覆盖的方式写入，内容登记为 promotion 环境唯一公钥，JSON 输出中的 deployment id 与 key id 同样固定登记。CLI 不接受 `$HOME` 作为状态或 Manager stable path 的权威：默认 home 必须来自操作系统账户数据库且 UID 与当前进程相同；显式绝对 XDG 根也必须逐段无符号链接验证。中立状态根、其子目录和不可变文件从已验证 state-home 目录 fd 逐段用 `mkdirat/openat(O_NOFOLLOW)` 创建或打开，文件提交与失败清理都绑定本次打开的 device/inode，成功创建或 unlink 后同步父目录，不能用先 `lstat` 再按完整路径 `open/remove` 的检查/使用分离流程。

challenge 文件必须是当前 UID 所有、单硬链接、权限不宽于 `0600` 的绝对规范普通文件；签发命令固定为 `ubitech-manager release-transition attest --config <absolute-manager.toml> --challenge <absolute-json> --receipt <new-absolute-json> --signature <new-absolute-signature>`。challenge、PEM、receipt 与 signature 均从逐段无符号链接打开且固定的父目录 fd 访问；输出只创建新 `0600` 文件、不覆盖旧证据，失败回滚只可删除本次创建且 inode 仍相同的对象，并同步对应父目录。任一目录或文件 identity 在操作中变化、现场状态不匹配或 control observation 不可用都不生成新回执。目标身份签发同一命令，但只允许启动路由从已验证 terminal handoff journal 选择目标 profile，不能通过参数、环境变量或二进制 basename 选择。

建立 journal 前必须同时满足：当前 Platform generation 与桥接清单声明的 predecessor 完全相等；Manager 自更新 `Current` 已稳定且 `Candidate`、`Activation`、普通或恢复 watchdog 均为空；Manager state 没有 active 或 finalize-pending operation，全部旧 operation 均为可验证终态；`maintenance=false`、公开状态为 `idle`；Platform reservation、Agent Run、durable job、Sandbox active call、Sandbox/host 后台进程和文件提交窗口均为空；源 unit、stable binary、配置、数据根、socket、Compose project、网络和 ownership label 与清单声明精确匹配；目标 unit、binary、配置、数据根、socket、Compose project、网络及 label 不存在；源和目标父目录是当前 UID 所有、不可被其它身份写入的真实目录，且数据 relocation 使用同一文件系统或经过完整 staging manifest 验证。等待任务只进入 `waiting_for_tasks`，不会提前创建目标对象；任一身份不确定都在零副作用边界失败。

这个边界的锁序固定为 `handoff global → runtime execution freeze → Manager maintenance admission`。每个经过认证的 executor 请求在完整 HTTP 调用期间都先取得 handoff global observation、再取得 runtime admission；配置写入也必须先取得同一个 handoff observation。因此一旦非终态 journal 落盘，新的 audit、terminal、process、file、Sandbox lifecycle 与配置修改都会明确拒绝，而不是只依赖短暂的内存 freeze。execution freeze 先拒绝新的执行调用，再等已准入调用退出；随后 maintenance admission 阻止新 operation、Sandbox lifecycle 和短文件提交窗口。锁内使用 Manager 内存 journal store 的单一快照严格枚举全部 operation，不得调用会清理临时文件的维护读取；自更新状态、watchdog 和执行计数任一不能封闭证明时立即失败。lease 只保持到 `planned` journal 原子同步完成；后续非终态 handoff journal 作为持久互斥证据，不依赖进程内锁永久占用。

Manager 的所有后台可变路径也属于同一准入边界，不得把“无用户请求”当作豁免。Capability/Firecrawl 对账、Sandbox 空闲停止与镜像刷新、受控维护清理、自动更新发布边界，以及后台进程终态落盘，都必须先取得同一 routed handoff observation，并保持到本次容器、注册表、journal、audit 或文件删除的最后发布点完成。之后才能依次取得 runtime、maintenance 或 fixed-stack 子锁，不得在已持有子锁时反向取得 handoff global。非终态 journal、准入 Store 不可用或身份不能封闭证明时，该轮后台动作必须零写入失败关闭；不得连为这次拒绝追加 audit。terminal journal 经同一观测重新验证后，后台循环才可从下一次迭代自动恢复。

Platform 只在 Manager capability 认证的 `GET /internal/manager/handoff/evidence` 返回这次观测所需的闭世证据：`schema_version=1`、source technical profile、SQLite migration version、`integrity_check`与`foreign_key_check`结论、Platform reservation/Run/durable-job/admission 计数、workspace 标记与 Camoufox sidecar readiness，以及规范化 Runtime/workspace identity SHA-256。`runtime_schema_ready=true` 只有在 Runtime 顶层集合、scope/lifecycle/session manifest、永久审批、每条 session/approval JSONL、幂等记录、引用关系、终态 status、整数时间单调性、文件数/大小上限，以及 canonical contract 登记的 P1 退役 checkout 库存全部通过与 transformer 相同的闭世界规则后才能产生；只枚举文件名或跳过正文 schema 不构成 readiness。响应体不超过 `256 KiB`、不带未知字段，不返回原始消息、凭据、宿主绝对 workspace 路径或数据库内容。Manager 对响应严格限大、拒绝重复/未知字段和尾随 JSON，并与本地 Manager/self-update/Sandbox、Docker 与文件系统证据交叉验证；单一 `healthy=true` 或日志文本不是证明。该端点纯读，不取得 update reservation，不创建 marker，不修复 schema。所有用于该结论的目录从受信根逐段 no-follow 打开并固定 fd，leaf 在读取后重新核对目录项 inode；路径替换、硬链接、符号链接、特殊文件或超限库存均失败关闭。

目标 Platform 在受限 target Manager 提供的精确 handoff 状态下启动，并用同一 `handoff_<32 hex>` 作为 Manager-owned reservation。helper 只有在 target 已确认完整 listener 所有权并把 `target_commit_planned` 单调 checkpoint 同步后才能请求结算；从该 phase 起响应不确定也只能向前对账，不得回滚到 source。这个 reservation 只能通过认证的 `POST /internal/manager/handoff/commit-release` 结算；请求是闭世对象，且必须同时绑定 `operation_id`、目标 `target_generation` 和 handoff journal 的 `binding_sha256`。Platform 先在 reservation 仍冻结时幂等提交 workspace 与 Camoufox machine schema，再把包含上述三个身份、数据库 schema version、UTC RFC 3339 时间原文和规范 JSON SHA-256 的 receipt 写入中性 Platform 设置，最后才释放 reservation 并恢复后台 worker。Manager 必须原样保存并参与摘要验证该时间字符串；允许解析后做时序判断，但不得重新格式化后替换原文，否则不同语言对小数秒的合法规范化会破坏 receipt 身份。schema 已提交但 HTTP 响应丢失、receipt 已落盘但进程重启，或释放后客户端重试时，同一三元组必须返回逐字段一致的持久 receipt 而不再执行 schema 副作用；任一字段不同都以冲突失败关闭。`GET /internal/manager/handoff/reservation` 只返回闭世的当前 reservation id/owner 和可选持久 receipt，不修复、释放或启动任何 worker。Manager 对两个端点的请求和响应都必须限大，拒绝未知、重复字段和尾随 JSON。

交接不是普通 `runUpdate` 的一个 phase。源 Manager 先持久化独立 handoff journal，再从已验证的不可变 Manager 工件安装并启动 owner-only、事务期间持久化的 user-systemd helper unit，并证明 helper 的 unit 文件、PID、可执行文件 SHA、参数、cgroup 和 journal 完全相符。该 unit 必须启用到事务 terminal，确保宿主重启后仍能按同一 journal 续作；写入 `committed`、`rolled_back` 或具备完整清理证据的 `aborted` 并完成验收后才禁用和删除。普通 transient unit 不具备跨重启所有权，不能用于此事务。helper 接管后是唯一有权写 handoff journal、切换数据根和启动目标 unit 的进程；源、目标 Manager 与 watchdog 均不得同时拥有该事务。公网 primary 与可选 LAN listener 通过事务目录内 owner-only Unix `SOCK_SEQPACKET` 通道传递 `SCM_RIGHTS`，消息必须绑定 schema、transaction id、规范排序的 listener 名称和实际地址，并以 `SO_PEERCRED` 证明同 UID；截断、未知或重复 listener、descriptor 数量不符以及任一身份变化都关闭本次收到的全部 descriptor 并失败。源端在 journal 确认 helper 接管前继续持有原 descriptor；helper 为每个已接管 listener 从自己的原始 FD 建立可单独关闭的 accept 副本并立即提供不含部署品牌、凭据或内部路径的固定 `503` 维护页。转交前 helper 只关闭这些 accept 副本，原始 FD 必须继续持有；发送或确认失败时从原始 FD 恢复维护服务，只有收到绑定精确 envelope 的确认后才关闭原始 FD。参与者必须先在 gateway controller 同一锁内采用完整 FD 集并启动 HTTP server，随后 receiver 才能发送确认。helper 保持维护页直至目标 Manager 用同一协议接管，不能在两个 Manager 间竞态重绑端口。宿主重启会丢失进程持有的 descriptor；恢复时只有 journal 当前唯一 owner 可以在持有同一 durable bind lock、重新核对 phase 和实际地址后重绑监听并继续维护页，其他 source/target 进程必须失败关闭，不能把 descriptor 不存在误判为可自由抢占端口。

helper 每次取得 writer lease 后、在任一 `source_fenced` 之后的非终态 phase 执行下一项宿主副作用以前，必须重新观测公网 listener 的完整 owner 与当前进程持有的 FD 集。当前 helper 持有完整 FD 时复验并保持中性 `503`；无人持有时只能由当前 journal owner 在 durable bind lock 下重绑并立即开始 `503`；受限 target/source 已持有时必须通过 nonce challenge、完整地址集与 systemd MainPID 证明唯一 owner，不能仅凭 phase 推断。unknown、双 owner、部分 FD 或 owner/phase 不匹配全部失败关闭。`source_retired` 的发送确认已完成但 phase 尚未同步时，重放必须识别已经证明的 target owner 并补写 checkpoint；`target_commit_planned` 重启丢失进程 FD 时，helper 必须先重绑、启动/证明受限 target 并重新完成或对账 listener 交接，确认 target 正在提供维护入口后才可调用 Platform commit。rollback 在停止 target 前先证明当时唯一 owner，停止后再次取得 helper FD 与维护页，才可继续恢复数据；因此任何崩溃点都不能提交一个公网端口未绑定的 terminal journal。

helper 在 global/transaction writer lease 内启动参与者时，还要使用独立的事务内 owner-only Unix `SOCK_SEQPACKET` startup channel。参与者先生成随机 nonce；helper 对同 UID `SO_PEERCRED`、`/proc/<pid>/exe` 运行 inode、stable inode 和 journal Manager SHA 做完整复核后，只返回一次闭世界 `StartupSnapshot`。快照固定绑定 schema 1、transaction、revision、`binding_sha256`、nonce、profile、status/phase/outcome、generation、Manager SHA，以及 stable/config/data/Manager-state/socket/Compose/network 全部精确值，并具有短期绝对过期时间。target 只接受 forward 的 `data_relocated|target_started|target_verified|source_retired`，source 只接受 rollback 的 `data_restored|source_started`；响应成功即消费能力并删除 socket，重复请求、响应重放、错误 phase/profile/executable、未知字段或超限数据全部拒绝。Router 消费的是 helper 已持锁得到的不可变快照，不能调用 `Store.Load` 或按 journal 路径重新取 flock。

source 与 target 的固定 user-systemd unit 不为一次交接改写 `ExecStart` 或安装临时 drop-in。helper 在启动参与者前只向 user-systemd Manager 设置唯一的短生命周期 locator `AGENT_PLATFORM_HANDOFF_TRANSACTION_DIRECTORY=<canonical transaction directory>`，随后启动 journal 绑定的精确 unit，并在所有成功、失败、取消和超时路径中用 `unset-environment` 清除该键；参与者的 `serve` 在打开任何 profile 配置、Manager state 或普通 operation journal 前读取并立即从自身进程环境删除它。该 locator 只能定位 startup channel，不能选择 source/target profile，最终身份仍只由一次性快照、stable 运行 inode 和 journal binding 决定。helper 自身子命令必须忽略这个键。正式 forward/rollback startup 固定使用 `startup-capability.sock`；围栏前异常恢复固定使用另一个一次性的 `abort-source-capability.sock`。Router 必须要求两者恰好存在一个：两者同时存在、两者都不存在、socket 类型/owner/mode 不符或连接模糊均失败关闭。abort capability 只携带 transaction、revision、binding、source stable SHA 与已解析的 source 固定布局，不携带 profile selector、Store 能力或普通 Manager 写权；受限 source 只能先建立 `helper-to-source` receiver，收到 helper 恢复的 listener 并等待 terminal/global lease 释放后才可提升。崩溃遗留 locator 不构成启动授权：没有当前 issuer、事务不匹配、能力已消费或 unit 已在运行但无法通过 owner-only control challenge 证明同一 transaction/revision/binding 时一律失败关闭；helper 重放先用 control challenge 识别已成功消费能力的参与者，只有权威证明不存在时才创建新 issuer 并再次启动，不能让已运行进程等待第二张能力。issuer 被 `SIGKILL` 后遗留的同角色 socket 只能由重新取得同一 helper writer lease 的继任者在确认另一角色 socket 不存在、连接明确 `ECONNREFUSED` 且 unlink 前 device/inode/type/owner 未变后清除；双 socket 永不自动猜测或清理。

参与者启动顺序固定为“消费 capability → 建立 listener receiver 与受限 owner-control → helper 证明参与者身份 → 启动并探测该角色固定 generation”。Platform 容器启动时必须恢复 Manager 持有的维护预约，所以受限 control 除身份、listener ownership 和 participant observation 外，只额外开放一个只读的合成 `GET /v1/status`：它不打开普通 Manager state/operation Store，只返回 `maintenance=true`，并把 `active_operation_id` 与 `operation_id` 精确固定为 capability 的 transaction id、`finalize_pending_operation_id` 固定为空。该状态只供同 token 的 Platform 启动恢复使用；配置、check、operation、executor、日志及任何 mutation 仍全部关闭。helper 必须先验证这个受限进程，再启动固定栈；先启动依赖 Manager socket 的 Platform 必然失败，不能把该顺序留给 Compose 重试碰运气。

目标 listener 完整接管并确认后，helper 先把 `target_commit_planned` 写入 handoff journal；该 checkpoint 以前尚未调用 Platform commit，失败仍可安全回滚。checkpoint 一旦同步就进入不可逆、单调 forward-only 区域：helper 只能用 transaction、bridge generation 与 binding 摘要反复调用目标 Platform 的持久幂等 `commit-release` 并对账，不能再切回 source。Platform 返回的 receipt 经严格校验后，helper 在一次 journal 提交中同时写入 `target_platform_commit` 证据和 terminal `committed`。因此 terminal journal 本身已经证明目标准入结算完成；目标参与者只在观察 terminal 且 helper 释放全局 lease 后原子提升为完整 Manager。rollback/abort source 的预约仍由 helper 在写入 source terminal 前释放。

coordinator 向启动实现和每个 helper listener FD 交接边界只交付由当前 helper writer lease 派生的只读 journal capability；该 capability 只暴露在既有锁内重新读取同一 revision 所需的 `Load`，不暴露 `Mutate`、Store 路径或重新加锁入口。target/source 启动实现必须用它建立 startup issuer；listener 实现必须在接收、重绑、采用维护副本、发送、确认和释放原 descriptor 的前后重新读取并严格复核同一 transaction、revision 与完整 journal。两者都不能只凭方法参数中的 journal 副本或可替换的 no-op authority 合成能力，也不能取得 coordinator 的可写 lease。

`committed` 后 helper 已退役，target 重启改由启动 Router 在任何应用副作用前，从预先安全打开并贯穿判定过程的 handoff 根目录 fd 取得全局 lease并枚举 journal；只有唯一 terminal commit 与完整 target binding、stable 运行 inode/SHA、配置、数据及 socket 身份全部匹配时才激活 target profile。Router 输出的完整 runtime binding 就是后续 serve singleton、startup ownership、restricted 参与者提升和 application/self-update 构造的唯一路径权威；其中 stable binary 必须原样传递，不得在路由后通过 `HOME`、`XDG_BIN_HOME` 或 profile 默认值重算。终态启动进程只从中立 state-home 派生 handoff 根；它在既有根和 global lock 下严格读取全部 journal，要求每条 journal 的 source/target data root 完全一致，再把这些已签名绑定当作 `Store` 的根边界并执行词法、逐段无符号链接、owner、mount/device 与物理包含关系复核。这个只读现有根入口不得创建目录、lock 或 locator 文件，也不得先读取 source/target 配置来选择路径；没有既有 journal 时 target 启动不适用该入口，普通 source 使用其已加载的 source 配置建立初始 Store。没有 handoff、terminal rollback/abort 都回到普通 source；非终态事务没有有效 helper 快照、多个冲突 terminal 或任何不安全对象则拒绝启动。这个 terminal 路由不能接受环境变量、argv、basename、manifest 或“目标目录存在”作为提示。

listener transfer 的唯一 wire envelope 是闭世界 JSON `{"schema_version":1,"transaction_id":"handoff_<32 hex>","listeners":[{"name":"lan","address":"<actual TCP address>"},{"name":"primary","address":"<actual TCP address>"}]}`。`primary` 必须恰好出现一次，`lan` 最多一次且仅在启用时出现；数组按名称字节序排列，descriptor 顺序与数组严格相同，总数只能为一或二。接收方完整验证并取得全部 descriptor 后，必须在同一 packet channel 返回闭世界确认 `{"schema_version":1,"transaction_id":"handoff_<32 hex>","status":"accepted","envelope_sha256":"<64 hex>"}`；发送方只在确认摘要等于实际发送 envelope 后才可持久化 helper 接管，超时或连接关闭均视为未确认并继续持有原 descriptor。channel 路径必须是事务目录内的 owner-only socket，收发双方都验证 peer UID、socket inode 与事务 id；包或 control message 截断、额外 JSON、地址无法规范解析、descriptor 不是已绑定 TCP listener，或 descriptor 实际地址与 envelope 不同都关闭整组 descriptor，不能部分接收。

三个传递方向必须使用事务目录内三个独立、固定且不复用的 pathname：源 Manager 到 helper 使用 `source-to-helper.listeners.sock`，helper 到目标 Manager 使用 `helper-to-target.listeners.sock`，helper 回滚到源 Manager 使用 `helper-to-source.listeners.sock`。每个 receiver 只拥有自己的 pathname：完整接收与确认后关闭并按已记录的 socket device/inode 精确 unlink，不得把同一路径按时序改作另一个角色的 channel，以免产生 pathname ABA。转换根的默认绝对路径可能超过 Linux `sockaddr_un` 的 107-byte 上限，因此 receiver 与 sender 都必须逐段无符号链接地打开并持有 transaction directory fd，再仅把短的 `/proc/self/fd/<dirfd>/<fixed-basename>` 传入 `bind/connect`；目录 fd、原路径视图和 socket device/inode 必须在确认前同时保持一致。不得把长的 XDG 路径直接作为 Unix sockaddr，也不得改用一个脱离 journal 目录的固定 runtime socket 规避长度。helper unit 启动时必须在续作 coordinator 之前建立 source receiver；`Begin` 同步完成 helper arm 后，现役 source 立即以返回的 `planned`（或幂等重放的 `helper_armed`）绑定启动阻塞式 source sender。sender 只复制 gateway 当前仍持有的精确 listener，并在 helper acknowledgement 前不关闭原件；它不再读取 Store 或等待 `snapshot_ready`。helper 只有在自己持有 global/transaction writer lease、当前 journal 已到 `snapshot_ready` 且 Expected/Authority 复核仍成立时才 Accept 并 ACK，因此早连接不是提前转移所有权。target、正式 rollback source 与 abort-before-fence 受限 source 在启动路由设置任何公网副作用前建立各自 receiver，并使用“验证全部 FD → gateway controller 原子 adopt/启动 → 发送 ACK”的单一接收边界；不能先确认再把 descriptors 交给 gateway。`helper-to-source` receiver 和 helper transfer 的闭世界 phase 集合是正式 rollback 的 `data_restored|source_started`，以及 abort 的 `planned|helper_armed|admission_reserved|writers_stopped|snapshot_ready`；其它 phase 一律拒绝。

helper 因自身或宿主重启丢失内存中的 descriptor 时，不能仅因 socket 列表为空就重新 bind。它必须仍持有同一 handoff global/transaction writer lease，为事务目录中持久的 `public-listeners.bind.lock` 取得 owner-only 独占 flock，重新验证 journal phase 与不可变 binding，再用精确 source/target public-owner probe 证明两个参与者都未拥有 journal 绑定地址，才可以按该绑定一次性重建 primary 与可选 LAN listener。probe 必须分别通过 source/target 的 owner-only Manager control socket，携带 Manager control token 与新生成的随机 nonce 调用 `POST /v1/handoff/listener-ownership` 发出闭世界 challenge；响应绑定 schema、transaction、role、nonce 以及 gateway controller 在同一锁内从真实 FD 读取的完整规范 primary/LAN 集。客户端必须在发送 token 前验证 journal socket binding、owner-only token 文件、socket owner/type 与 Unix peer PID；不存在证明只能源自已经验证的 participant process absence 加缺失或同 inode 明确拒绝连接的 endpoint。这个 process absence 是该角色的权威 `owns=false`：进程已经不存在就不可能继续持有 FD，因此另一角色返回完整、认证的 `owns=true` 时必须识别为唯一 owner，不能因已证明缺席的一方没有 HTTP 响应而降为 `unknown`。等待 listener 的存活参与者必须认证返回 `owns=false`，只有 adopt 完成后的参与者可返回 `owns=true`。helper 所有权只能由 HelperDriver 当前完整真实 FD 集加 helper authority 共同证明。control socket 明确不可达但 participant process absence 未被证明时不得进入 fallback 或推断 non-owner；只有两方都已认证为 non-owner 或已被权威证明不存在后，fallback 才连接完整地址集，任何连接成功为 `unknown`，全部地址明确 `ECONNREFUSED` 才可为 `none`。不能仅凭端口占用、单地址或普通健康页猜 owner。任一探针为未知、地址冲突、绑定不完整或 lease 变化都关闭本次创建的全部 descriptor 并失败关闭。`CommitToTarget` 或 `RestoreToSource` 的崩溃重放中，nil/closed listener 只能通过目标角色的精确 public-owner 证明解释为“已转交”，或在上述独占恢复边界内安全重建后再传递；绝不能把 nil 解释为“本事务没有公网 listener”。

#### Handoff journal schema

P1 不保证默认 `<home>/.local/state` 预先存在。A2 Candidate 可在不打开或修改 source data/schema 的前提下，从经操作系统账户数据库验证的 home 目录 fd 出发，用 `mkdirat/openat(O_NOFOLLOW)` 只创建缺失的 `.local/state/agent-platform/handoff`，并在每层创建后同步父目录。任一既有组件必须是当前 UID 所有、真实目录且不可被组或其它身份写入；symlink、owner/mode 异常、路径替换或与 source/target data root 存在词法/已挂载物理包含关系都必须在数据写入前拒绝。非默认显式 `state_home` 若不存在则仍失败关闭，不得通过 argv 任意建树。

journal 使用 schema 1、`0600` owner-only 普通文件和同目录 flock，事务目录本身为 `0700`、不位于会被直接 rename 的源或目标根内。每次变化都以临时文件、file fsync、rename 和 parent fsync 原子提交；`binding_sha256` 覆盖 `source`、`target`、`release` 与首次 `evidence` 的规范 JSON，后续重放不得改写这些字段。结构固定为：

第一个 source-profile 发布只交付 `namespace_handoff` 清单解析、校验和无副作用拒绝边界，不注册 CLI、不生成描述符，也不加入任何能创建事务或传递 listener 的无消费者代码。在完整 source-owner 发布接通以前，`Check` 和 `runUpdate` 即使解析出合法描述符也必须在保存清单、下载工件、写入 Candidate 或进入维护以前明确拒绝，绝不能把顶层目标 Manager/Compose 当成普通源身份更新。`namespace_handoff` 是可选的闭世界对象；一旦出现就必须完整包含 schema 1、`predecessor_generation`、与顶层 `source_commit` 相同的 `bridge_generation`，以及 `source`、`target` 两个闭世界 binding。每个 binding 只能包含 `profile_id`、`manager` 和 `compose`；源 profile 固定为 `ubitech-agent-v1`，目标 profile 固定为 `agent-platform-v1`，两者不得相同，且两侧 Manager 必须同时提供 `amd64` 与 `arm64` 工件。源 Manager version 必须等于 predecessor generation，目标 Manager version 必须等于 bridge generation。桥接清单的顶层 `manager`、`compose` 与 `images` 描述目标 generation，其中目标 binding 的 Manager/Compose 必须与顶层逐字段一致；源 binding 显式绑定可回滚的源 Manager/Compose。描述符为 `null`、字段缺失、未知字段、非规范摘要、额外架构或任一跨字段身份不一致时，整份清单失败关闭，不能退回普通 update。

完整 A2 source-owner 发现 B 时，`Check` 只可在普通 handoff/runtime 准入下原子保留已验证 manifest 并清除任何旧的普通 Candidate，随后释放该普通观察 lease，再调用 handoff coordinator。coordinator 必须自行按 `handoff global → runtime freeze → maintenance` 的唯一顺序建立 `planned` journal；不得在仍持有普通 `Check` 的 global lease 时重入 coordinator，也不得在两者之间发布普通 Candidate。若间隙中另一个普通 operation 先取得所有权，handoff preflight 必须无副作用失败并由下一次同 manifest 检查重试。`Check` 成功返回一个 handoff manifest 表示独立交接已经建立或幂等复用，自动更新器不得随后为它创建普通 update operation。

source-owner 的配置层必须先把状态目录解析成规范化绝对路径，再显式传给 handoff；handoff 包本身不得读取或展开 `$HOME`。非默认状态目录必须由安装或配置流程持久写入 `manager.toml` 的 `state_home`；启动 Router 不把可变的 ambient `XDG_STATE_HOME` 当作 locator 权威。配置未声明 `state_home` 时，只允许从操作系统账户主目录派生 `<home>/.local/state`；配置层可以在生成或更新持久配置时读取绝对的 `XDG_STATE_HOME`，但不得让一次进程环境变化绕过该持久绑定。解析后在创建任何对象前验证账户主目录及既有路径逐组件由当前 UID 所有、无符号链接且不可被组或其它身份写入。journal 根固定派生为 `<resolved-state-home>/agent-platform/handoff`。现役 source data root 和 target data root 的既有父目录执行相同验证；其读取权限可以遵循既有 XDG 配置。journal 根与每个事务目录必须是当前 UID 所有、无符号链接且权限精确为 `0700` 的真实目录，journal 与同目录 lock 必须是当前 UID 所有、单硬链接、无符号链接且权限精确为 `0600` 的普通文件。journal 根与源/目标 data root 在任一方向存在词法或已挂载物理身份包含关系都必须在创建目录前拒绝，避免 journal 随数据搬移、回滚或清理而丢失。journal 根还必须有一个 durable 全局 singleton flock；建立或恢复任一 transaction 时锁序固定为 global 后 transaction，同一部署任何时刻最多存在一个非终态 handoff，不能用不同 transaction 目录绕过唯一 owner。开始新交接与普通 operation 的共同锁序固定为 handoff global 后运行准入：交接 owner 在同一 global lease 内确认没有非终态事务、取得运行准入、完成只读 preflight 并原子写入 planned journal，journal 落盘后才释放运行准入；普通 Check/Start/Recover 则先取得只读 global lease、确认没有非终态交接，再取得运行准入并发布普通状态。不得把 Discover、preflight 和 Create 分成三个可被普通 operation 穿过的独立窗口，也不得使用相反锁序。source/target namespace、unit、binary basename、配置目录、Compose project、网络和 label prefix 必须直接由同一个编译期 `identity.Profile` 校验，不能在 manifest、journal 与执行器中各自维护常量。journal、helper、listener、CLI、恢复发现与实际迁移动作必须作为同一 source-owner 能力整体接通并通过崩溃矩阵，不能先发布无调用方的半套实现。

```json
{
  "schema_version": 1,
  "revision": 1,
  "transaction_id": "handoff_<32 hex>",
  "status": "running|recovering|committed|rolled_back|aborted",
  "desired_outcome": "forward|rollback",
  "phase": "planned|helper_armed|admission_reserved|writers_stopped|snapshot_ready|source_fenced|target_staged|data_relocated|target_started|target_verified|source_retired|target_commit_planned|committed|rollback_planned|target_stopped|data_restored|source_started|rolled_back|aborted",
  "binding_sha256": "<64 hex>",
  "release": {
    "predecessor_generation": "<40 hex>",
    "bridge_generation": "<40 hex>",
    "manifest_path": "<absolute path>",
    "manifest_sha256": "<64 hex>",
    "target_manager_sha256": "<64 hex>",
    "target_manager_version": "<release version>",
    "target_compose_sha256": "<64 hex>"
  },
  "source": {
    "namespace": "ubitech-agent-v1",
    "unit": "ubitech-agent-manager.service",
    "unit_enabled": true,
    "unit_path": "<absolute path>",
    "unit_sha256": "<64 hex>",
    "stable_binary": "<absolute path>",
    "stable_sha256": "<64 hex>",
    "config_path": "<absolute path>",
    "config_sha256": "<64 hex>",
    "data_root": "<absolute path>",
    "socket_path": "<absolute path>",
    "compose_project": "ubitech-agent",
    "core_network": "ubitech-agent_core",
    "core_network_id": "<docker object id>",
    "label_prefix": "org.ubitech.agent"
  },
  "target": {
    "namespace": "agent-platform-v1",
    "unit": "agent-platform-manager.service",
    "unit_path": "<absolute path>",
    "stable_binary": "<absolute path>",
    "config_path": "<absolute path>",
    "data_root": "<absolute path>",
    "socket_path": "<source-preflight-resolved absolute runtime socket>",
    "compose_project": "agent-platform",
    "core_network": "agent-platform_core",
    "label_prefix": "io.agent-platform"
  },
  "evidence": {
    "manager_state_sha256": "<64 hex>",
    "self_update_state_sha256": "<64 hex>",
    "sandbox_registry_sha256": "<64 hex>",
    "docker_inventory_sha256": "<64 hex>",
    "database_schema_version": 1,
    "database_integrity": "ok",
    "runtime_identity_sha256": "<64 hex>",
    "workspace_identity_sha256": "<64 hex>",
    "boot_id": "<uuid>"
  },
  "snapshot": {
    "path": "<absolute path>",
    "manifest_sha256": "<64 hex>"
  },
  "helper": {
    "unit": "agent-platform-namespace-handoff-<12 hex>.service",
    "unit_sha256": "<64 hex>",
    "executable": "<absolute immutable path>",
    "sha256": "<64 hex>",
    "argv_sha256": "<64 hex>",
    "control_group": "<exact systemd cgroup>"
  },
  "target_ack": {
    "manager_version": "<release version>",
    "executable_sha256": "<64 hex>",
    "source_commit": "<40 hex>",
    "pid": 1234,
    "socket_path": "<the same absolute runtime socket as target.socket_path>",
    "auto_update_check_at": "<RFC3339>",
    "issued_at": "<RFC3339>",
    "proof_sha256": "<64 hex>"
  },
  "target_platform_commit": {
    "schema_version": 1,
    "operation_id": "handoff_<32 hex>",
    "target_generation": "<40 hex>",
    "binding_sha256": "<64 hex>",
    "database_schema_version": 2026072901,
    "committed_at": "<RFC3339>",
    "receipt_sha256": "<64 hex>"
  },
  "abort_cleanup": {
    "reservation_released": true,
    "staging_removed": true,
    "listeners_restored": true,
    "source_identity_verified": true,
    "source_public_ready": true
  },
  "history": [{"phase": "planned", "at": "<RFC3339>", "note": ""}],
  "error": "",
  "created_at": "<RFC3339>",
  "updated_at": "<RFC3339>",
  "completed_at": null
}
```

示例中的数据库 schema 数字只是类型占位，真实值必须等于桥接清单与数据库 marker。初始 `evidence` 只包含建立事务前已经存在的只读事实；恢复快照不得伪装成 planned evidence。顺序固定为 reserve admission、停止全部 writers、生成并验证快照、写入一次 `snapshot`，随后才可推进 `snapshot_ready` 和 `source_fenced`。`helper` 必须在 `helper_armed` 前以写入一次、冲突拒绝的方式持久化；从该 phase 起每个 journal 都必须包含它，且其 unit 身份和可执行文件摘要必须绑定事务与目标 Manager 工件。`target_ack` 的权威证明只能由执行目标 stable inode 的目标 Manager 通过 owner-only handoff capability 生成；helper 是 journal 的唯一 writer，负责复验并持久化该证明，但不能生成、代签或从健康探测推断。它必须在 `target_verified` 前持久化并从该 phase 起强制存在，其 Manager version、source commit、可执行文件摘要和 socket 必须分别等于 journal 绑定的目标 version、bridge generation、目标 Manager SHA 和目标 socket；`issued_at` 不得早于 history 中持久化的 `target_started` 时间，也不得晚于当前 journal 更新时间。`target_platform_commit` 只能与 terminal `committed` 同一次写入，并必须逐字段匹配本 journal 的 transaction、bridge generation、binding、数据库 schema 与 Platform 持久 receipt 摘要。snapshot、helper、target ack、target Platform commit 和 abort cleanup 证据一经写入不得覆盖。secret 内容、token 和原始数据库内容不得进入 journal，只记录路径身份与摘要。

持久 helper 的入口在任何普通 startup Router、profile、配置或 operation state 读取之前由闭合静态命令表识别。它只接受各一次的 `--transaction`、`--journal` 和 `--listener-socket`，逐项等于 transaction 目录中推导出的 owner-only journal 与 source-to-helper socket；未知、重复、缺失、位置参数以及环境 locator 都不能影响选择。helper 先用外置 handoff 根打开已存在事务并验证 journal，再从 journal 的真实 source/target binding 装配 Runtime、Data、participant、listener 和 systemd 边界，随后只通过 `OpenHelper + Coordinator.Resume` 取得 writer lease；它不得打开普通 source 或 target Manager state。journal 只持久化由 transaction 确定的 unit/executable 路径与摘要、argv 摘要和 systemd control-group 等静态身份；PID 与 boot id 只作为每次启动的即时证明。systemd 或宿主重启后，helper 必须以新 PID 重新证明同一静态 unit、运行 inode、argv、cgroup 和当前 boot，再重放同一事务，不能把旧 PID 当永久所有权。任一 terminal journal 同步并完成 helper unit 自禁用后，helper 都以成功状态正常退出；原始迁移失败只留在 journal/status，不能用非零退出触发 `Restart=on-failure` 循环。稳定 Manager 随后完成静态 helper 清理。

目标数据根发布后、启动目标 participant 之前，helper 还独占一个 `HostInstallationBoundary`。该边界只从 journal 和已经验证的目标 Manager 工件生成精确 stable binary、目标配置与 user-systemd unit，以 fd-relative/no-follow 的原子安装、file fsync、rename 与 parent fsync 提交；配置保留源配置中用户设置的运行参数，但所有技术路径、unit、profile、Compose/network、control socket 和 secret 路径必须重新绑定 journal 的 target identity。崩溃重放只接受摘要、mode、owner 和内容完全相同的三个对象，任何未知对象或漂移都失败关闭；目标 unit 在 forward-only commit boundary 前不能 boot-enable。回滚必须先证明目标 unit、固定栈及其它 writer 全部停止，再仅按本事务证明精确删除这三个安装对象和空配置目录；terminal `committed` 保留它们。source preflight 把目标 runtime socket 解析为规范绝对路径后写入 journal；目标配置、participant、`target_ack`、helper challenge 与 Compose control mount 必须逐字节相等，禁止 `$XDG_RUNTIME_DIR` 逻辑值、后缀匹配或其它双重表示。

每个 phase 只接受上一 phase或该 phase 已完成事实的幂等重放；发现后继事实时只能按明确列出的半提交规则补 checkpoint，不能跳阶段。`revision` 每次持久变化严格加一，并在持有 global 与 transaction lock 后以 compare-and-swap 方式复核。`source_fenced` 前只有在 reservation 已明确释放、事务 staging 已清除、listener 所有权已恢复、source identity 与公网健康已复验并把完整 `abort_cleanup` 写入后，才能提交 `aborted` 安全终态。这个围栏前收尾使用独立的 `RestoreSourceBeforeFence` 边界：它在 writers/fixed stack 从未停止的 phase 只重新证明 source Manager 仍是唯一 owner，在已停止的 phase 才幂等恢复并证明源栈；不得调用只允许 `recovering + data_restored|source_started` 的正式 startup issuer，也不得为 abort 伪造回滚 phase。若 source unit 已在围栏动作的半提交窗口停止，helper 必须仍持有 writer lease并重新验证当前 pre-fence journal，创建独立 owner-authenticated `abort-source-capability.sock` 后才可用同一个短生命周期 transaction locator 重启它；该启动只进入 abort-before-fence 受限参与者。启动进程只消费 nonce-bound abort snapshot，验证 transaction/revision/binding、source stable 运行 inode和完整 source layout，不打开 Store、不取得 writer 权，也不生成或消费正式 `StartupSnapshot`；它先等待 `helper-to-source` listener，helper 写入 terminal、释放 global lease 后才从既有 journal 的普通 source 路由提升为完整 Manager。terminal journal 同步后，正在执行的 helper 先证明自身 unit/process/inode 与持久证据一致并只禁用开机启用关系，然后正常退出，不能调用 `systemctl stop` 杀死自身。稳定的 source 或 target Manager 随后在证明该 unit inactive、无 PID 且静态 unit/executable identity 未变后精确删除两者并 daemon-reload；这个可重放收尾未完成时保留文件但不会重新取得事务所有权。

`admission_reserved` 已允许 stop Sandbox/固定栈产生部分副作用，所以围栏前收尾必须把该 phase 视为“可能已经部分停写”：无论 StopAll、StopFixed 还是最终 stopped probe 在何处失败，都要根据权威状态幂等执行 source `StartFixed` 并通过完整固定栈 probe，再验证 source identity/public readiness 和释放预约。只有更早且不可能调用停写动作的 phase 才可以只做 owner 证明；phase 尚未推进不能作为“未产生副作用”的证据。

从 `source_fenced` 到 `source_retired` 的错误先把 `desired_outcome` 单调改为 `rollback`、`status` 改为 `recovering` 并进入 `rollback_planned`，回滚按反向 phase 恢复数据位置、源 Docker ownership、源 unit enabled 状态、源 Manager inode及公网入口，全部探针通过后才写 `rolled_back`。一旦 `target_commit_planned` 已同步，helper 不再写 rollback intent：它保留目标 listener 与维护页，对 `commit-release` 和 receipt checkpoint 做有界、幂等重试直至 terminal `committed`。回滚暂时或永久无法完成时，对外投影 `failed + maintenance=true`，但 journal 仍是非终态 `recovering`；不可逆提交暂时无法完成时同样保持维护，但 journal 为非终态 `running/forward`。持久 helper 在两种情况下都保持启用并继续重试，不得把失败投影当作不可再推进的终态，也不得同时启动两套 unit。

#### 实现切点与发布门

桥接实现必须作为一个完整变更同时接通以下边界，不能只增加 CLI 或目录复制脚本：

- `containers/release-manifest.schema.json`、`manager/internal/release/manifest.go` 与 release workflow：加入版本化 handoff 描述符、predecessor、目标 Manager 和目标 Compose 工件，并确保桥接前普通清单不触发；
- `manager/internal/model`、`manager/internal/journal` 与 `manager/internal/operation`：公开等待/维护投影与 handoff transaction 互斥；独立 handoff journal 不能放进将被搬移的普通 operation 根，也不能走 `runUpdate` 的失败回滚；
- 新的 `manager/internal/handoff` 与 Manager helper 子命令：实现 owner/type/no-symlink 校验、flock、phase 重放、systemd helper 身份证明、单 listener 交接、源/目标 unit fencing及反向恢复；完整实现以前不得注册该命令；
- helper 的 production assembly 与 `HostInstallationBoundary`：必须从已验证 journal 装配真实 source binding，并在目标启动前原子安装 journal 绑定的 stable binary、配置和 unit；命令闭世界、跨重启重放、目标 socket 单一绝对绑定、安装半提交和回滚精确删除都必须有生产路径测试，不能用默认 source data root 或环境 locator 猜测；自定义 source `data_root` 的 target 必须闭世界派生为其同级目标根并保持同盘，自定义 `state_home`、config home 与 runtime root 也必须写入配置/unit 的持久启动契约；`target_commit_planned` 也属于 target startup capability 的 forward-only 允许阶段，重启后必须重新证明目标 participant 再继续幂等 commit；
- `manager/cmd/.../main.go` 与 `manager/internal/selfupdate`：普通 Candidate 必须先完成 watchdog commit，再允许 handoff；stable path、unit、socket、token 和 startup ownership 必须显式绑定 source/target profile，目标 Manager 只能用 `target_ack` 接管；
- `manager/internal/config`、`manager/internal/driver`、`manager/internal/sandbox` 与 `manager/internal/snapshot`：生成固定目标配置，迁移数据根，重建 neutral Compose/network/label/container ownership，转换已停止的 Sandbox registry，并保留精确源快照；ownership 守卫必须认识“当前事务指定的一次转换”，不能永久接受双前缀；
- Platform、Agent Runtime、Camoufox、Compose 与容器入口：桥接 generation 同时能在源环境启动、在目标环境完成一次迁移，显式转换数据库 marker、Runtime/session/idempotency、workspace marker、Cookie 和浏览器持久状态；清理 generation 随即删除源读取；
- helper 的 production `DataBoundary`：构造时必须确认 [`data-layout.md`](../reference/data-layout.md#命名空间交接的数据变换) 的全部当前 schema reader/transformer/validator 已注册，否则 source-owner 拒绝启动。`StageTarget` 只能建立同 transaction 的 owner-only sibling staging；`TransformAndPublish` 先验证完整 manifest 再原子发布，并可凭同一 request/manifest 摘要识别“rename 已完成而 phase 尚未写入”的崩溃 checkpoint；`RestoreData` 只能在 target writer 已围栏后移除本 transaction 发布且身份摘要完全匹配的 target。正常协议在 `source_fenced` 前绝不建立 target staging，因此 `RemoveTargetStaging` 只验证 target 与同 transaction sibling staging 都不存在；任一存在都保留证据并失败关闭，且不得为围栏前收尾读取、枚举或 checkpoint source 根。四个方法都必须幂等，既有 target、空或非空未知 staging、跨设备路径、未知 Manager/runtime 工件和任何身份变化都失败关闭；
- 容器拥有的数据树：资源必须显式区分 `native` 与 `container_owned_tree`；只有闭世界 `byte_exact_tree` 可选后者。Engine 通过注入的 `PrivilegedTreeFS` 使用同一桥接 release 中完整 digest 固定的 `handoff-fs-helper` 执行库存、复制、复验与受围栏删除，Manager 普通进程不能直接递归读取或 `chown` 容器 UID 数据。source owner 必须在关闭准入和 Arm helper 前预拉取 manifest 全部受管 target 镜像的精确 digest 并复验本地 RepoDigest；这项工作在 planned journal 已同步后使用独立、持久且有绝对上限的 arm context，不能继承 HTTP/control `check` 的 45 秒 deadline。任一失败时 source 仍权威且可安全重试，helper 尚未获得所有权。source preflight 还必须安全读取并严格解析 predecessor 的本地 manifest 与 Compose，把两者的原始规范绝对路径和内容 SHA-256 写入不可变 binding；`planned` journal 原子同步前仍然只读，不能提前创建恢复材料。journal 同步后、helper 获得所有权前，source owner 必须重新用 no-follow、owner/type/link/inode 稳定性检查读取 journal 绑定的 predecessor manifest/Compose 和 bridge manifest/Compose，以 no-replace 方式复制到由 transaction id 闭世界派生的外置 recovery bundle，依次同步文件、目录与事务父目录。已有 bundle 只接受相同 mode、owner、单链接与逐字节摘要，任何原路径删除、替换、摘要漂移或 bundle 冲突都在 source 仍权威时失败。此后 helper production assembly、跨进程/跨重启重放、数据转换所需 bridge bytes，以及每次 source `StartFixed` 都只从该 bundle 安全重读并复核 journal 摘要；source release 清理或原路径消失不能破坏恢复。恢复 source 固定栈前还要逐项证明 predecessor 的 `platform` 与 `agent-runtime` 精确 RepoDigest 已在本机，Compose 明确使用 `--pull=never`，禁止围栏后访问 registry 或接受同仓库 tag/其它 digest 替代；能力服务与按需 Sandbox 不属于回滚提交门，源 Manager 恢复完整控制面后再按正常 degraded/reconcile 规则收敛。helper worker 本身必须 `--pull=never`、无网络、只读根、最小 capability、无新权限、有界 PID，并只挂 source(ro)、transaction staging(rw) 与 owner-only control(rw)；闭世界 request/receipt 同时绑定 transaction、request、resource 和 image 摘要，worker 全程 fd-relative/no-follow/no-xdev。取消和残留只能按精确 ownership labels 清理，删除还必须先有 handoff writer lease、target writer fence 与 publication proof；
- Gateway 与 control API：handoff 期间持续返回中性维护页，状态端点从源路径一次性交接到中性路径；目标自动更新至少成功执行一次带认证的 `check` 后才允许 commit；
- CI：从上一真实公开 release 安装，不从当前源码夹具伪造源状态；对上述每个 phase 和 journal/状态双文件边界注入 kill/断电，证明自动继续或完整回滚、始终只有一个 Manager/Docker owner，并在清理 release 验证所有源常量与迁移入口已消失。

清理 generation 只有在验收得到可连续执行普通 D/E 更新的 `target_baseline` 后才算完成：下一次普通更新必须只消费 target profile 的 manifest、Compose、Manager、数据根与 Docker ownership，不能继续等待桥接 descriptor、source reader 或一次性 helper；否则更新通道仍视为冻结，不能删除最后恢复证据或报告清理成功。

在这些切点全部实现并通过端到端崩溃矩阵之前，任何 release 都只能作为源侧能力的前置基线，不能发布 `namespace_handoff` 描述符，也不能暴露一个表面成功的 handoff 命令。当前普通 operation journal、自更新 plan、配置默认值、Compose environment、Docker ownership 和 Sandbox registry 都绑定源身份；在该状态下直接启用交接会使恢复 watchdog 找不到原路径、目标 Manager 无法证明 Current、或两套控制面竞争同一端口和 Docker 对象。失败关闭比在唯一部署机上生成不可回滚的半迁移更安全。

## 检测与预拉取

管理员可以启用 Manager 轮询、从管理界面提交检查，或使用宿主 CLI。其它进程不得实现第二套更新器。发现更新时，Manager 先校验 HTTPS、协议版本、宿主架构、数据库版本、磁盘空间、Manager 工件和全部镜像 digest，再在平台仍可使用时准备候选工件。切换前只强制预拉取 Platform 与 Agent Runtime 的精确 digest；本地已经存在的 digest 不访问 registry。每个缺失核心镜像的拉取同时受无输出空闲时限和较大的绝对上限约束，超时在进入维护前记录为可重试失败，继续保留 current generation。Camoufox、SearXNG、Firecrawl 与 Agent Sandbox 镜像由各自的后台收敛或首次使用独立拉取，不能因第三方 registry 缓慢阻塞核心更新。

宿主 CLI 的手动 `update` 也必须先通过当前技术身份的认证 control socket 调用一次 `check`，不能直接建立普通 operation。`check` 返回普通 manifest 时，CLI 才按既有流程提交并等待普通 update；返回带 `namespace_handoff` 的 manifest 时，服务端已经建立或复用了独立 handoff，CLI 必须立即停止，且不得再向 `/v1/operations` 提交普通 update。这样手动更新、管理界面和自动轮询共享同一个描述符分流边界，桥接清单不会因入口不同落入 `runUpdate`。未知 CLI 子命令必须先由静态命令表拒绝，再读取 handoff journal、配置或 Manager 状态；任意用户输入不能触发一次技术身份路由。

release 与工件 URL 只允许 HTTPS，或主机名精确为 `127.0.0.1`、`::1` 的回环 HTTP；字符串前缀相似的外部域名不属于回环。每一次 HTTP 重定向都必须重新执行同一策略，HTTPS 不得降级到外部 HTTP。JSON 清单使用规范、大小写敏感的闭世界字段名，重复字段、大小写别名、未知字段、尾随值或超限正文全部失败关闭。

所有受管镜像都使用同一份按镜像上限目录。能力服务或 Sandbox 在按需拉取前先精确检查本地 digest，只为缺失项累计压缩层与展开后上限，并对 Docker 文件系统执行普通进程可用字节和 inode 门禁。容量不足时只运行一次受控维护并重新计算；仍不足就保持现有服务、把能力标记为 degraded 或让本次 Sandbox 创建明确重试，不能继续拉取到磁盘耗尽。能力栈先逐 digest 完成有界拉取，再执行 Compose 收敛，不能让 Compose 隐式拉取绕过容量门。失败时只删除本次调用开始前不存在、仍无容器消费者的精确 digest；不得清理未知 layer 或其它项目资源。

镜像就绪后公开状态进入 `waiting_for_tasks`。Platform 继续服务，直到没有以下活动：

- Agent Run 以及 queued/running durable job；
- 已完成网络接收、正在把消息/附件/邮件 checkpoint 等权威状态原子提交到本地的短准入窗口；
- Manager 登记的 Sandbox 或 host 后台终端；
- 其它不能安全跨 generation 切换的写操作。

Manager 不为更新强行终止任务。任务自然结束后，排队更新自动继续。只有 Manager 本地进程登记为空闲后，它才请求 Platform 在对话锁内原子复核业务状态并建立 reservation。候选校验、下载和任务等待期间不持有固定容器切换锁；只要 `maintenance=false`，current generation 的能力后台仍可修复。Manager 取得 reservation 后才与能力收敛互斥并进入固定栈切换边界。

自动学习复盘遵循同一静默边界，但排队与执行必须区分：尚未领取的复盘 durable job 可以跨 generation 保留，不单独阻塞更新；一旦 worker 领取复盘并登记为活动，它就和前台 Agent Run 一样阻塞 reservation，直到结果已持久结算或失败重排。reservation 建立后不得领取新复盘；进程关闭时仍在执行的复盘必须先取消 Runtime，再把同一 job 安全重排，不能丢弃计数、重置变更预算或把半完成结果当成成功。

网络接收或只读外部探测不能无限占有 Platform 写准入。持续前进的附件上传没有普通墙钟总时限，但 multipart 只写非权威 staging；完整请求读完后才竞争短提交准入。若更新先取得 reservation，上传连接可以随旧 Platform 停止，staging 在请求清理或下次启动时删除，客户端明确重试。后台 IMAP 轮询同样在准入外读取；每个 checkpoint、消息/任务事务和错误状态落库前重新竞争短准入，更新已经预约时放弃本轮并由新 generation 从旧 checkpoint 重试。交互式邮件调用属于正在运行的 Agent Run，仍由任务本身自然阻塞更新；不能再用一个额外、不可收敛的网络 admission 重复阻塞。任何可能产生本地写入的网络结果都不得在 reservation 后补写。

## 原子准入与维护

Manager 使用 control capability 请求 Platform readiness/reserve。Platform 在同一个锁边界内完成最终空闲检查并关闭新消息、后台 worker 和写任务准入。Manager 收到成功响应后先持久化同一 operation 的 `maintenance=true`，再用相同 operation id 重复 reserve 并取得确认；第二次确认前不得停止 Platform 或修改数据。

reservation 结算是两个认证且闭世界的独立动作，不得共用一个“释放”端点猜测结果。普通更新的 `commit-release` 与 `abort-release` 请求正文都必须是大小受限且字段精确为 `operation_id` 的单个 JSON 对象；重复字段、未知字段、缺字段、尾随 JSON 和非 UTF-8 全部在副作用前拒绝。`commit-release` 只允许 install/update 的 candidate Manager 已被独立 watchdog 耐久提交后的 finalize 路径调用；Platform 必须在 reservation 仍持有时原子验证 owner，再提交 workspace marker 与 Camoufox sidecar 等可使 previous binary 不可读的 machine schema，全部成功后才释放准入并恢复 worker。`abort-release` 只释放 reservation，不得调用任何 schema/marker commit；所有候选失败、传输不确定后的取消、Manager watchdog 回滚、显式 rollback、restart 和 repair 都只能走这条路径，并在完整 current schema 纯读复验后恢复 worker。两个动作都绑定精确 operation id 且可幂等对账；commit 中任一 schema 写入失败必须继续保持 reservation 和维护页。Gate 已成功而 operation `Finalized=true`、Manager state 仍为 `finalize_pending` 的半提交窗口也必须先对重启后的 Platform 重放同一种幂等结算（install/update 重放 `commit-release`，其它 operation 重放 `abort-release`），成功后才清 state；SelfUpdate、`OnCommit` 等非 Gate hook 不得重复。

这段半提交窗口由 Manager `/v1/status.gate_settlement` 提供耐久且闭世界的启动投影：字段必须显式存在，普通状态为 `null`；只有同一次锁内快照精确证明 Manager `maintenance=true`、`public_state=updating`、没有 active/candidate、finalize slot 引用同一条 `succeeded + Finalized=true + committing` operation，且 current generation 与 operation target 完全一致时，才返回只含 `schema_version=1`、`operation_id` 与 `action` 的对象。`action` 必须来自 operation journal 中与 `Finalized=true` 同次耐久写入的 `gate_settlement_action`，不能在恢复时按 kind 猜测：install/update 只有在 watchdog 已耐久确认 Manager candidate 时记录 `commit`，没有 SelfUpdate 的受支持模式仍记录实际执行的 `abort`；restart/rollback/repair 只能记录 `abort`。未知 action/kind 组合、损坏 journal、错位 slot 或不完整终态都投影 `null`。首次 finalize 必须先执行一次 Gate，再把实际 action 与 `Finalized=true` 同次持久化，随后无条件重放同一 Gate，最后才清 Manager state；恢复路径只重放 journal action，不重复其它 hook。Platform 在启动时若读到精确 settlement，就不得重建 reservation，而要以该 operation id 初始化对应的 committed/released 幂等身份，使 Manager 的第二次 Gate 在 Platform 已重启时仍明确成功；字段缺失、畸形或与状态错配都必须失败关闭。

任一 reserve 响应丢失或结果不确定时，Manager 必须对同一 operation 尝试 release。只有 release 明确成功才可回到非维护失败状态；release 失败则保持 `failed + maintenance=true` 并由恢复循环继续对账。每个 Platform 进程在启动 Agent、知识摄取、计划任务或 Telegram worker 前都必须读取 Manager 的持久 reservation；状态不可读时启动失败，不能把未知状态解释为空闲。

公开状态固定为：

- `idle`：当前 generation 正常；
- `waiting_for_tasks`：候选已准备，等待业务自然空闲；
- `updating`：维护生效，正在切换；
- `failed`：无法证明安全运行，继续显示维护页并等待修复。

公开 `/api/platform/update-status` 载荷固定为 `state`、`phase`、`operation_id` 和 `retry_after_ms`；`operation_id` 直接来自 Manager 当前 operation，不使用第二套实例标识。

operation 为 `install`、`update`、`restart`、`rollback` 或 `repair`；phase 由 [`container-platform.json`](../contracts/container-platform.json) 定义。operation journal、current/target/previous generation、心跳和有界错误均写入 Manager 状态根并原子同步。

## 更新事务

进入维护后的顺序固定为：

1. 锁定 operation 与不可变目标清单；
2. 停止当前可写 Platform，并证明没有第二个数据库 writer；
3. 对 SQLite 和需要同步切换的 sidecar 数据建立一致快照；
4. 运行版本化、幂等、事务化 schema 与文件迁移；
5. 启动候选核心服务并执行核心 readiness，同时异步启动受管能力服务；
6. 原子提交 current/previous generation；
7. 完成 Manager 自更新确认和其它当前 generation finalize hook；
8. 明确释放 reservation，恢复公网入口和后台 worker；
9. 各 Sandbox 空闲时独立刷新其基础镜像。

提交前必须在 reservation 仍生效时再次探测 Manager 控制面、Platform、Runtime 与公网入口，确认运行中的核心容器与目标 digest 完全一致；不能只复用较早的 readiness 结果。能力服务继续按独立 degraded 语义收敛。

Platform 与 Agent Runtime 属于 generation 的核心 readiness；Manager 自身还必须持续持有公网入口和 owner-only 控制接口。Camoufox、SearXNG、Firecrawl 与 Cognee 是能力级服务：核心 generation 提交后由后台收敛器逐项拉取和启动，它们未收敛时只降级浏览器、搜索、网页提取或知识能力，不能回滚已经健康的核心 generation、阻止 finalize、让整个平台进入长期维护，或终止 Manager。Agent Sandbox 镜像在对应 Sandbox 首次创建时执行相同的本地 digest 检查和有界按需拉取。release 若因不可分割的数据迁移确实依赖某项能力服务，必须在发布契约中显式声明本次临时门禁，并提供不依赖该服务自身健康的恢复路径，部署机不能临时猜测。

Firecrawl 显式使用 `NUQ_BACKEND=pg` 的 PostgreSQL 队列基线。后台收敛检查 Playwright、Redis、RabbitMQ、Postgres 与 API，并把结果投影为独立服务状态；FoundationDB 及其初始化任务不属于当前发布、运行或健康目录。收敛使用有界等待和指数退避，失败只把网页提取标记为 degraded。只要 Manager、Platform 与 Runtime 正常且未进入维护，Firecrawl 修复可与候选校验、核心镜像预拉取和任务等待并行，不能占用全局维护门。

## 自维护与空间回收

Manager 在启动、更新成功后和低频定时器中运行同一幂等维护循环。只有 `idle + maintenance=false`、没有 activation/active/finalize operation 且 Sandbox/host 执行登记稳定时才允许删除；仅由更新检查产生、尚未进入 operation 的候选可以存在，但必须进入保护集合。更新 preflight 为释放容量而显式允许当前 operation 进入维护循环时，该 operation 必须是唯一未终结 operation，其 `target_generation` 与 `snapshot_path` 也必须分别作为 release 与快照保护项；任一 operation journal 不可读、身份不一致或出现第二个未终结 operation 都失败关闭。清理准入与 operation 创建、候选发布及按需 Sandbox 注册共用短临界区，不能在读取空闲状态后与新执行交错。每轮先计算保护集合：current、previous、候选、自更新 activation、未终结 operation、回滚快照、正在运行或已登记 Sandbox，以及全部现有容器引用的镜像和挂载。

清理对象必须同时具备可验证的 Manager provenance 和零消费者。数据库 generation 快照使用 `migration_backup_retention_seconds` 的七天恢复窗口；不可达 release、对应受管 digest 镜像、旧 Manager binary 与可证明来源的 staging/download 临时工件使用独立的 `obsolete_artifact_retention_seconds` 一小时宽限，避免高频发布把镜像积累到磁盘耗尽。已 finalized 且具有有效 `completed_at` 的终态 operation journal 只在同时超过七天窗口、不属于按完成时间排序的最新 `128` 条，且不被 Manager state 的 active/finalize id 引用时才可删除；非终态、未 finalized、缺失完成时间或被 state 引用的 journal 永不进入裁剪候选集。这个有界尾部同时定义历史 operation 查询和 idempotency replay 的最小持久保证；裁剪后的更旧终态 id 不再是可查询 API。终态 recovery journal 与 activation plan 属于独立审计证据，不进入 operation journal 裁剪，也不作为普通临时文件泛化删除。每轮依次尝试快照、release（连同其不可达镜像）、operation journal 和旧 Manager binary 四个独立清理域；一个域失败不得跳过其余安全域，最终聚合有界错误与各域删除计数。每个对象独立、非 force 删除并记录有界结果；未知文件、未知 label、符号链接、路径越界、仍被引用或状态读取失败都跳过。禁止 `docker system/image/volume prune`、按仓库名通配删除、递归清空 backups/data 或处理其它项目的 Docker 资源。

原子写入中断后只能把同目录下名称精确匹配 `.tmp-` 加无前导零的 `uint32` ASCII 十进制表示（1–10 位）的工件视为 Manager 临时文件；这是当前原子写入器的完整命名契约，构建测试必须证明实际 writer 产生的名称仍可被识别，实现差异只能失败关闭。持久 state、operation、activation、recovery 和 manifest 引用不得指向这类名称。共享清理器只在已打开并证明为绝对 canonical、当前 UID 所有、非符号链接的精确受管目录上工作，比较目录和候选文件的 `lstat`/`fstat` inode，并且只删除同 UID、普通、非链接、`nlink=1` 的文件；删除后同步已打开的父目录。清理目录必须由 canonical Manager 根与定长子路径派生；即使持久 Version 记录包含绝对路径，也只能在它精确指向固定 `Root/versions/<identity>/ubitech-manager` 后用其直接父目录作为清理根；根外路径必须在任何 unlink 前拒绝。平时必须等待 `obsolete_artifact_retention_seconds` 宽限；只有启动前同时具备单实例证明与相应写域锁，或持有对应域的独占 single-writer 锁并证明没有 writer 时才可不等宽限。精确名称但类型、owner、inode 或链接数异常的对象始终保留并报错。仍在宽限内的对象也保留：若其位于随后将严格枚举或验证的启动关键目录，本次启动失败关闭；若它不参与启动身份验证，启动路径不扫描该目录，由低频维护在宽限后收敛，不能为清理无关工件人为制造长时间启动循环。Manager 每次启动在任何 journal 枚举前只清理 recovery/operation 和已引用 version 等严格启动关键目录，周期维护在自身域锁内使用同一原语收敛非关键残留，不放宽未知文件规则。对于名称为精确 commit 的非保护 `releases/<commit>/` 目录，周期维护只在取得维护准入锁、重新确认保护集后，用这一原语删除已超过一小时宽限的精确原子残留，然后从头严格验证 manifest、Compose 和闭世界目录内容，才允许其参与 release 及镜像裁剪。新鲜残留、任何 `.tmp-` 近似名、未知文件、持久引用异常或对象身份变化都必须保留证据并阻止该 release 与镜像被删除；只要其核心 manifest 与 Compose 仍可验证，维护循环就把其中的受管镜像加入本轮保护集，避免另一个共享 digest 的 release 越过这一阻断边界。

更新 preflight 在下载前检查数据根与 Docker root 所在文件系统的普通进程可用字节和普通用户可用 inode。Manager 先按精确 digest 检查本机，仅为缺失的 Platform/Runtime 镜像累计 [`container-platform.json`](../contracts/container-platform.json) 中的压缩层上限与展开后上限，再加下载安全余量。切换前的字节门槛不是一个孤立常数：Manager 对每个当前受管快照源取逻辑文件大小和已分配块大小中的较大者并安全求和，再加契约中的 `update_pre_cutover_min_free_bytes` 固定安全余量；文件类型、大小计数或整数边界不可证明时失败关闭。发布 CI 必须对两个受支持架构逐项验证压缩层和展开后尺寸不超过这些上限，超限 release 不得发布。当前严格 manifest 协议保持原 JSON 形状，以免尚未接收本次 Manager 更新的实例因未知字段自阻断；容量估算与同一 source commit 的 canonical contract 和发布门绑定，而不是由部署机猜测。

数据根与 Docker root 位于同一文件系统时只采用该文件系统所需门槛的最大值，位于不同文件系统时分别满足各自门槛；字节使用普通进程可用块，inode 使用普通用户可用 inode。第一次切换容量检查发生在建立 Platform reservation 前，容量不足时当前 generation 继续在线并先尝试一次受控维护。reservation 成功后、停止任何 writer 之前必须重新读取快照源和文件系统余量；此时不再删除工件，若余量因并发增长而不足，Manager 必须明确释放同一 reservation，再把 operation 作为可重试的切换前失败结束。无法确认 reservation 已释放时继续保持维护状态，不能冒充在线失败。

首次容量检查不足时，Manager 先运行一次受控自维护：只清理超过宽限、可证明归属且没有消费者的旧工件，然后重新读取缺失 digest、快照源大小和文件系统余量；维护不能满足门槛时才把 operation 标为可重试失败。失败的镜像拉取只清理本次调用开始前不存在、能够由目标 immutable digest 证明归属且仍无容器消费者的候选镜像；Docker 全局缓存、未知 layer 和其它项目资源绝不泛化清理。成功提交后尽快再次运行维护循环，再按指数退避处理暂时仍被 Docker 引用的旧对象。两阶段均至少保留契约 inode 门槛；同一文件系统只计算一次。清理失败只报告独立 degraded 状态，不能回滚已经健康的 generation 或把业务长期锁在维护页。

维护循环把准入快照与慢速检查分离：短临界区记录状态 epoch 和保护集合，目录校验、hash 与 Docker 枚举在锁外执行；每个删除边界都必须重新取得准入锁并确认 epoch、current/previous/candidate、未终结 operation、Sandbox 与容器消费者仍与计划一致。Manager binary 由更窄的 recovery lock 和其自身 state 二次校验串行化，不能与通用准入锁形成反向锁序。保护集发生变化时放弃本轮对象而不是沿用旧快照。

## 数据库迁移

数据库 schema version 随 release 单调递增。候选 Platform 镜像以一次性迁移命令打开数据目录，执行独立编号且创建后不可变的迁移。DDL、数据复制、外键校验和 migration marker 必须属于同一事务；失败时不得启动候选 writer。

重建被外键引用的表时，迁移必须显式处理所有当前子表，按子到父顺序切换，并在提交前执行完整外键检查。空表也必须验证其外键定义。数据库 migration 失败由 Manager 恢复与 previous generation 绑定的快照，不以运行时猜测结构或跳过版本来兼容。

## 回滚与崩溃恢复

候选 readiness 失败时，Manager 停止候选容器，验证并恢复 previous generation 对应的数据库与 sidecar 快照，再启动 previous generation。快照创建只有在内容、manifest 与父目录全部同步后才算成功。恢复必须先验证文件类型、大小和 hash，在独立 staging 准备完整集合，再以可补偿的原子切换替换数据库、WAL 和 SHM；失败时必须保持恢复前数据完整或同步补偿。

每次显式 rollback 在进入维护前先按本地精确 digest 检查并有界准备 previous 的 Platform/Runtime 镜像；准备失败保持 current 在线并作为可重试操作结束。镜像就绪后才建立 reservation，并为当前 generation 创建一致快照。交换 current/previous 时，镜像 generation 和对应数据 generation 必须一起交换，使连续 A→B→A→B 始终使用正确数据。

Manager 在任一 phase 被终止、宿主重启或 Docker 重启后，从 operation journal 幂等收敛。数据库迁移 one-off 容器使用确定名称、Manager ownership label 和 Compose project label；恢复数据库前必须先清除已证明归属的残留迁移 writer。无法证明数据库和容器 generation 一致时保持维护，`repair` 不能绕过未完成的 `rolling_back`。

operation 终态与 Manager state 的半提交窗口必须显式收敛：失败 operation 已落盘但 active id 未清除时只能完成失败收尾；current 已提交但 finalize 尚未完成时保持 `finalize_pending` 和维护，重新执行核心探针及幂等 finalize hook，最后才释放 reservation。若 operation 已写 `Finalized=true` 而 pending state 尚未清除，恢复仍须对可能已重启并从 pending state 重新取得 reservation 的 Platform 重放同一 Gate 结算，再清 pending state；不能因 operation 终态而跳过 Gate，也不能重复 SelfUpdate 或提交回调。能力级服务的健康状态不参与该探针。任何 checkpoint 写入错误都必须可观察，不能伪造完成。

候选 Manager 尚未被 watchdog 接纳时，journal 损坏、核心 readiness 失败或控制入口不可用必须使候选进程退出，由 watchdog 恢复 previous Manager。普通 activation 一旦由 watchdog 判定失败，必须把失败 Candidate 从可自动激活状态原子移除并在终态 plan 中保留身份；previous Manager 重启后不得再次激活同一二进制。若 Platform generation 已经提交但仍在等待这次 Manager activation，恢复循环使用原 operation、原 reservation 和原更新前快照自动停止失败 generation、恢复 previous generation 与数据、释放 reservation，并把本次更新终结为可重试失败。该回退在每个 journal 半提交窗口都必须幂等；不能留下永久 `finalize_pending`，也不能要求人工清除 Candidate。

当前基线不接受未完整绑定身份的 activation plan。普通 plan 必须在首次持久化时同时写入 `candidate_path` 与 `platform_commit`，并在启动确认、watchdog 回滚、外部恢复接管和终态收敛的每个边界与已验证且已提交的 Candidate、Activation 和 Platform generation 精确匹配。任一字段缺失、部分绑定、身份漂移或文件篡改都必须失败关闭；恢复路径不得从 Current、Candidate、manifest 或路径规则推断、补写这两个字段。接管 journal、watchdog、回滚和 recovery activation 仍保留原始 plan 字节哈希与完整身份链作为持久证据。

普通 rollback 的 plan-first 半 checkpoint 只有在 Candidate 的 version、source commit、SHA-256、验证时间和 `platform_committed=true` 均完整，Candidate 路径精确等于其受管 version 目录中的 `ubitech-manager`，Activation 的 plan path 精确等于该 Candidate 的受管 plan 路径，且 plan/state/stable/运行 inode 全链一致时才可由启动流程补清。`pathWithin`、目录名前缀或单独 hash 命中都不足以建立该终态所有权；任一字段篡改必须保持 state 不变并失败关闭。

候选已经成为 current 后，恢复或 finalize 的暂时错误不再是 Manager 进程级致命错误：Manager 必须保持公网维护页和控制接口在线，持久保留原 operation，并由后台循环带退避重试。不可恢复错误同样不得形成 systemd 崩溃循环；它保持安全维护状态并向宿主 CLI 提供有界诊断和受控恢复入口。

候选固定服务启动或探针失败时，Manager 在删除容器前采集有界的 healthcheck 和日志诊断。所有诊断先脱敏再截断；采集失败可以附加错误，但不能阻止安全回滚。

## Manager 自更新

Manager 使用版本目录、持久 activation intent、独立 watchdog 和原子 current/previous 切换更新自身。候选二进制先完成自检、journal 解析和核心 operation 收敛，再绑定 control socket 与公网入口并通过探针；只有 watchdog 确认后才能成为 current。Manager 身份探针必须经过 owner-only control capability 认证，只返回运行 release version 与运行可执行文件 SHA-256，不得执行 Docker 或下游服务检查；完整服务目录与 Manager 进程存活是两个独立信号。任一提交前失败都恢复 previous Manager 二进制及其 unit，不能覆盖唯一可启动副本。

命名空间交接后，watchdog 与 `recover-current` 仍可能从 stable 之外的不可变 inode 运行。它们必须先通过中立 handoff journal 的全局只读 lease 取得唯一 source/target authority，再分别由 activation plan 或 recovery journal 验证自身 inode、摘要、unit、stable 路径和事务；命令行提供的 plan/config 只能与已选身份做等值校验，不能成为身份选择器。非 helper 入口只能先从显式 config 最小解析 `state_home`（缺省为操作系统账户的固定默认值）定位 journal，不能在 terminal journal 选择 profile 前按 source 规则全量加载 target config；这条顺序必须覆盖 committed target 的宿主重启、普通 CLI、watchdog 与外部恢复。普通 Manager 和 CLI 仍要求运行中 inode 与 stable inode 精确一致。

每次 `serve` 在自更新检查以前先取得贯穿整个进程生命周期的 owner-only 单实例锁；该锁不由 `recover-current` 外部命令持有，锁序固定先单实例锁、后全局 recovery lock，保证外部命令停止旧服务后新 recovery Manager 仍可启动探测，同时任何第二个普通 serve 都非阻塞失败。Candidate control listener 在 watchdog 提交前必须由原子 handler 栅栏限制为认证 `/v1/identity`；只有 acknowledgement 与 commit 都完成后才开放 status、executor 和 operation。每个 Unix socket 路径另有 owner-only、`O_NOFOLLOW | O_CLOEXEC` 打开的 durable sibling bind flock；它跨越 probe、stale unlink、bind 和 listener teardown，并在 socket unlink 与 fd close 后才释放，使不同 Manager root 也不能并发 claim 同一路径。已有 socket 只有在持有该锁时有界连接明确 `ECONNREFUSED` 且 unlink 前同 inode/type/owner 复核通过，才能作为 stale 删除；live、锁繁忙或模糊状态一律保留并拒绝启动。listener teardown 也只能删除自己绑定的 inode，不能按旧路径删除继任 socket。

下载 Manager 候选前必须先按固定顺序持久化唯一所有权：operation 的 `target_generation`、Platform `Candidate`，最后才是自更新 `Candidate`。这样任一进程退出后，自更新启动门都能从同一未终结 operation、受管 manifest 与 Platform Candidate 精确证明候选归属。Platform generation 尚未提交时，任何正常失败都必须按相反依赖顺序清理：先通过严格 `DiscardPrepared(manifest)` 只清除版本、source commit、SHA、受管路径完全一致且 `platform_committed=false`、没有 Activation 的自更新 Candidate，再条件清除仍属于同一 active operation 的 Platform Candidate，最后才允许把 operation 写成终态。候选二进制本体由受控维护循环按保护集合和宽限期回收，不在失败路径递归删除。

反向清理本身是持久事务。首次触碰自更新 Candidate 前，operation 必须原子记录 `prepared_cleanup_pending=true`、原始失败原因和 retryable 分类；该 marker 一旦落盘，普通恢复不得再进入 `runUpdate`、重新下载、Prepare 或 reservation，只能从受管 `releases/<target>/manifest.json` 与 operation target 重建同一清理意图。重放依次接受并验证四个单调 checkpoint：两个 Candidate 都在、自更新 Candidate 已清而 Platform Candidate 仍在、两个 Candidate 都已清但 active operation 尚在、失败 operation 已落盘但 state 仍指向它。`DiscardPrepared` 必须幂等并在返回前重读证明 Candidate/Activation 均为空；Platform Candidate 只能在完整等于受管 manifest generation 时清除，也可接受已经为空。最后以一次 operation 原子写同时清除 marker 并写成 finalized failed，再清 active owner 并恢复 idle；若进程在两次 journal 写之间退出，恢复只补做失败 state 收尾，不能再经过 reservation 分支。marker 写入前崩溃可按原 phase 正常重跑；marker 写入后、终态 operation 写入前的任何身份不一致、文件不可读或写入结果不确定都必须保留 marker 与 active owner、更新有界诊断并失败关闭，不能覆盖原始原因或伪造终态。

普通 activation 先将绑定 Candidate、Platform commit 和 previous 不可变二进制的 plan 与 state intent 持久化，再启动唯一的独立 watchdog。finalize 在激活候选前查询本 release 是否已被 watchdog 回滚时，只有已存在且完整匹配的 activation plan 才能进入加锁对账；这条纯查询路径不得创建 activation 目录或 lock。全新 Manager root 尚无 plan 时必须返回“未回滚”，随后由 `Activate` 安全创建 owner-only activation 目录并开始首次切换。重放只能继续同一份已绑定的非终态 plan：不得重写为 `prepared`、不得为同一 plan 创建第二个 watchdog。同名 transient unit 已存在时必须验证其 PID、不可变可执行文件、参数、cgroup 和 plan 路径后将其视为现有所有者；身份不可证明时失败关闭。每份普通 plan 具有 owner-only 的跨进程 mutation flock；Activate 按“全局 recovery lock → plan lock”取得锁，候选确认与普通 watchdog 只取得 plan lock且不得反向取得全局锁。plan/state/stable 的每次普通提交或回滚都必须在 plan lock 内重新读取并验证所有权，不能用锁外快照覆盖另一进程已经写入的终态；普通提交在锁内必须重新读取 plan 并确认其为同一完整绑定、`activated=true`、`acknowledged=true`、状态为 `acknowledged`，重新确认 Candidate/Activation 全部身份仍匹配，并在写 state 前即时验证 stable SHA 等于 Candidate。若 state 已原子提升为 Candidate Current、引用已清除，但进程在 terminal plan 写前退出，generation finalize 屏障本身必须在同一 plan flock 内用 manifest、Current/Previous、stable 与完整 `acknowledged` plan 精确证明该半 checkpoint并只补写 `committed`；不依赖原 watchdog 仍存活，任何可解析但冲突的 plan 都拒绝。没有该 release plan 的既有 Current 快速路径保持只读。恢复接管的提交使用独立的 takeover 所有权契约，不能借用普通提交的判断。候选启动确认和等待提交必须直接校验 Linux `/proc/self/exe` 所代表的运行中 inode，不能对 `os.Executable()` 返回的启动路径求 hash；stable 路径被原子回滚后，仍运行的旧 Candidate 不得把恢复后的 Current 路径误认成自己。启动或重启 systemd unit、控制 socket 探针等可能阻塞的外部调用不占用 plan lock，调用返回后必须重新取锁对账再写入。watchdog 在看到已持久的 `activated` 后从自己的 systemd cgroup 提交 Manager 主 unit 重启，并在同一进程内最多成功提交一次；Manager 主进程不得在自己将被停止的 cgroup 内同步等待 `systemctl restart`，也不得把该调用被 systemd 终止误判为候选失败。若 state intent 已持久但 stable 尚未替换时 previous Manager 重启，该尝试已经失去连续所有权：必须与 watchdog 回退一样写入标准 `rolled_back` 终态并同时清除 Candidate/Activation，不得留下只有 Candidate 而没有 Activation 的中间状态。若回滚已恢复 stable、但在写 `rolled_back` plan 或清除 Candidate/Activation 前中断，周期性的回滚屏障检查必须在 plan lock 内重新证明 Current、Candidate、Activation、不可变二进制与 stable 全部精确匹配；`activated`/`acknowledged` plan 可先补写有界错误的 `rolled_back`，随后只补做 state 清除，`prepared` plan 不得据此推断已回滚。无论当前仍是旧进程还是候选进程都不得因可执行文件身份不同跳过收敛，任何不匹配则不改写引用。watchdog 必须将 `committed`、`rolled_back` 和受控 superseded 识别为终态，迟到或重放的 watchdog 不能再恢复 previous。watchdog 取得完整绑定后 plan 丢失或损坏时，只能用内存中最后一份已验证快照与当前 state、Candidate、Current 和 stable 二次对账；精确 state 已提交且 stable 仍为 Candidate 时重建 `committed` plan，仍完整持有未提交状态时才可恢复 Current 并重建回滚证据，无法证明所有权则不得改写任何状态。

普通 activation 的独立 watchdog 不受 Manager 主 unit 停止影响。外部恢复遇到遗留 Candidate/Activation 时，必须先验证 Platform `finalize_pending`、Manager state、activation plan、不可变二进制和 stable hash 是同一提交链，再停止并证明主 unit与该 plan 的所有 watchdog 都已退出；仅持有新版本 recovery lock 不能证明旧 watchdog 已失活。若普通 plan 已为 `rolled_back`、Candidate 与 Activation 仍保持完整原绑定且 stable 已精确恢复 Current，外部恢复在全局锁内再取得 plan lock，只能先补清这条标准回滚半提交，再重读 state 进入无 activation 的恢复路径；绑定被篡改时失败关闭，这不是对缺失 Activation 的旧状态兼容。隔离完成后先持久化绑定原始 journal/hash、Manager 配置和 unit 初始启用状态的 takeover transaction；随后临时禁用主 unit 的自动启动并证明该 fence 生效，再把旧 activation 收敛到登记 Current 的标准回滚 checkpoint。只有 journal 已持久化且仍在 `plan_superseded`、旧 plan 精确反向绑定同一 transaction、stable 精确为 Current 时，才允许把“旧 Activation 已清除但阶段写未完成”的 Candidate-only 状态识别为事务内部崩溃 checkpoint 并补记 `activation_cleared`；无 journal 的同形状态始终拒绝。`activation_cleared` 之后 stable 可以处于 Current 或精确 recovery SHA；若 recovery plan 已在 state intent 前落盘，它必须是 journal 唯一确定的 `prepared` plan，缺失时可幂等创建、可解析但身份不同则不得覆盖。创建新 intent 时必须先把 stable 换成校验恢复二进制，之后才写带 `recover_current` 标记的 plan、Candidate 与 Activation，保证任一重启边界都不会启动旧 Candidate。新 plan 被 state 引用且新 watchdog 的进程身份得到证明后，只有新 watchdog 能执行 commit/rollback 或写 current/previous；外部命令只可按 takeover journal 单调确认 stable、激活 plan、恢复主 unit 启用状态并启动服务，随后成为只读观察者。所有状态写都必须带 transaction/plan/Candidate 条件校验，任何路径都不得产生两个 commit/rollback 所有者。恢复 plan 的不可变内容必须完全由 takeover journal 确定。若 plan 文件丢失或语法损坏，watchdog 可用最后验证快照，外部终态恢复可用 journal 确定性重建；两者都必须在同一 mutation lock 内重新证明当前 state/stable 的精确提交或回滚边界。已存在且可解析但身份不匹配的 plan 不得覆盖。无法证明任一精确边界时不得改写状态。恢复回滚必须清除可自动激活的 Candidate、恢复并验证登记 Current 服务；完整失败身份只保留在 takeover journal，旧 Manager 不得自行重试同一失败候选。

control API 在提交 2xx 前完整编码响应。mutation 只返回有界身份和状态确认；客户端对空、截断、超限或非法 JSON 的成功响应视为结果不确定，并使用原 idempotency key 与 operation journal 对账。外部错误正文写入 journal 前必须脱敏和限制大小，重复失败只保留初始上下文与最近错误，不能递归嵌套历史诊断。

若 current Manager 的旧二进制缺陷使其在启动恢复阶段持续退出，后台轮询本身不可达，不能声称继续推送普通 release 会自动获救。此时只使用[部署文档](deployment.md#manager-失联恢复)定义的校验恢复入口先替换 Manager；恢复成功后由同一 operation journal 补完原 finalize，再恢复普通更新。不得只覆盖 stable 文件而不登记 Manager Current，也不得手工清除 `finalize_pending`。

## 验证

发布门至少覆盖：

- 全新数据根安装与启动；
- 多个正常任务跨过轮询周期时继续排队更新；
- 数据库 schema 迁移成功、失败与外键回滚；
- 核心镜像拉取空闲/绝对超时、核心 readiness 和 Manager 自更新失败；
- Manager 主 unit 自重启的真实 systemd cgroup 语义，并证明只有独立 watchdog 提交重启、`signal: terminated` 可重试、同一非终态 plan 不被重写、已有精确 watchdog 不被重复创建，且迟到终态 watchdog 不再回滚；
- Platform 已提交但旧 Candidate/Activation/watchdog 循环时，受控恢复能隔离旧 watchdog、结算到 Current checkpoint，并以新 recovery activation 完成或标准回滚；
- 受控恢复在 unit fence、stable 替换、intent、watchdog handoff、重新启用主 unit 和 terminal journal 的每个持久边界重启后均只能继续同一事务；
- watchdog 已提交 Manager state、Platform 已完成 finalize 但 recovery plan/journal 尚未终态化时，只补齐缺失元数据，不得再次移动 Current/Previous；
- operation 在每个持久 phase 被终止后的幂等恢复；
- current Manager 在 `finalize_pending` 核心探针暂时失败时保持控制接口在线、带退避重试，并在服务恢复后只 finalize 一次；
- Firecrawl 整体不可用或能力镜像 registry 卡住时 Platform 与 Runtime 仍完成 finalize、退出维护并将网页提取标记为 degraded；
- current/previous 镜像与数据 generation 的往返回滚；
- Firecrawl PostgreSQL 首次启动、保留同一 bind 数据后的幂等重建和真实提取请求。
