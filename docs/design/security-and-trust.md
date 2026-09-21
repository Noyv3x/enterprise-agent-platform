# 安全与信任边界

本页拥有认证、审批、secret、网络与文件规则；[数据设计](data-memory-sessions.md)拥有持久事务，[数据布局](../reference/data-layout.md)拥有路径/marker与直接迁移例外，[Runtime](agent-runtime.md)拥有执行协议，[自动更新](../operations/auto-update.md)拥有 generation/recovery 状态机。

## 信任模型

部署面向可信内部成员，不抵抗同部署恶意租户。私人/频道主 Agent 各有 Sandbox、workspace、HOME、session、memory、Skill/MCP、浏览器 Profile；委派继承父环境。这是防误操作/污染的隔离，不是恶意模型或提示词注入安全边界。

Sandbox 默认免审但受 hard-block。模型显式选择的单次 host 调用须用户逐次批准，才由 Manager 以部署用户执行；terminal 可用其已有免密 sudo，等同授予本次部署用户乃至 root 权限。不得变成 Run 默认或永久授权；部署方负责成员、宿主及网络权限。

## 认证与权限

| 对象 | 不变量 |
| --- | --- |
| 密码 | PBKDF2-SHA256+随机盐。全部写入口/登录最多1024 Unicode字符，超限不改 hash/token version。登录闭世界 JSON ≤16 KiB，拒重复/未知字段，用户名限长；字符检查先于哈希。 |
| 防爆破 | 固定窗口三桶：账号×真实客户端、账号跨客户端、客户端跨用户名。客户端桶先保护 CPU；仅账号跨客户端桶不阻止正确密码，账号×客户端及客户端准入仍适用。未知账号用固定 dummy hash，错密码验证现有 hash，执行等价 PBKDF2并返回统一错误；限流有稳定码/Retry-After。 |
| 窗口状态 | session secret 派生 HMAC主体标识存 secret settings，不存用户名/IP/密码；时间/键数有界，成功/过期/容量回收清桶，重启不清零。不引入永久封号、验证码、外部风控。 |
| 撤权 / 改密 | 停用、改密、权限变化、吊销推进 token version。本人改密可事务外验密，但提交 CAS 旧 hash+version+active，仅用本次版本签发；不得覆盖先提交操作或借新版本续命。 |
| 管理写 | Python 在短串行/事务提交边界重验当前 active、权限、认证版本；先提交撤权必须挡住旧请求。正文前 actor、前端按钮/角色不授权；长网络等待不占全局 conversation gate。 |
| 本人撤回 | 同频道消息锁重读账号/权限，验可读、聊天权、消息可见、author_type=user、user_id=本人；admin 不绕所有权，代删走管理审计。 |

浏览器 HMAC token 的 Cookie 为 HttpOnly、SameSite=Lax；TTL=Max-Age，默认7天、可调60秒至30天，关浏览器不失效。签发时计算绝对 exp；有效 Cookie 剩余寿命低于当前 TTL一半时以同 version续签；bearer、过期、停用、版本失效不续。

可信代理开启时 Secure 取 Manager 清洗重建的本次 scheme，HTTPS加、LAN HTTP不加；关闭时忽略伪造 Forwarded/X-Forwarded-*，以公共 URL scheme回退。Cookie写需允许的 Origin/Referer；真实客户端仅信 Manager重建头，否则 TCP peer。

## 容器与网络边界

| 边界 | 不变量 |
| --- | --- |
| Docker / network | 只有 Manager访问 Docker socket，其它服务不得挂载/代理。Manager持有持久私有 bridge，Compose仅引用 external network；仅接管契约 managed label/driver，不覆盖同名未知网络。只将 Platform backend发布宿主回环，sidecar不公开。 |
| 技术身份 | schema 2 target-only manifest精确闭合十现役镜像；无 helper/历史解码/额外描述符、mutable tag、任意 shell。编译期 profile固定机器身份，品牌/CLI/manifest不能选另一套。 |
| Sandbox root | 仅PID1映射阶段：正整数UID/GID、无其它账号UID冲突；workspace/HOME/env三挂载根非symlink，只改根owner/mode，不递归、不碰只读附件。随后exec部署agent身份，docker exec显式同UID/GID，无root业务进程。 |
| Platform root | 仅entrypoint/固定健康dropper。serve/init-admin/print-agent-token/__healthcheck在建目录、读secret、加载业务前清附加组、no-new-privs并降部署UID/GID；其它root命令拒绝。root Python仅镜像绝对解释器+isolated+root-owned cwd，不从数据/环境导入。migrate唯一例外见[受控迁移](../reference/data-layout.md#受控迁移)。 |
| 内部认证 | Platform/Runtime内部HTTP（含内部健康）需独立token，浏览器session不替代。Manager socket同时验同UID peer及严格Bearer；路径、地址、scope、容器名不授权。 |
| capability | manager-token供Platform/CLI/回调控制；manager-executor-token仅Runtime `/v1/executor/*`，不可互换/交叉挂载。只读挂独立control目录而非socket inode或整个状态根，允许socket重建但不暴露其它状态。 |

Manager每次启动验control/secrets真实目录与token：部署UID、非symlink，目录0700、普通文件0600；仅安全对象可收紧，owner/type/path异常不修复。只读挂载/SO_PEERCRED不能代替路由capability。

网络能力有不同准入：

- 搜索/Firecrawl仅公开HTTP(S)，拒userinfo、回环/私网/链路本地、metadata、敏感query；结果轻过滤不能代替提取前DNS-aware SSRF复验。
- 浏览器可访问普通回环/内网HTTP(S)，拒userinfo、metadata、链路本地、多播/保留/不可路由，操作前后复验。
- release/工件仅HTTPS或精确127.0.0.1/::1 HTTP，逐redirect复验；策略拒绝是确定失败，不按网络错误重试。
- 更新webhook验签，Telegram webhook用不可猜secret path；边界代理覆盖客户端转发头。

## 工具执行与审计

Runtime生产执行统一Manager，无本地terminal/process/文件fallback；开放服务前bearer非空且Unix路径确为socket。测试fake不得改变同接口审批/身份语义。

所有目标在执行前canonical参数/路径、限大、脱敏及hard-block：Docker/编排/Manager状态、宿主凭据/进程内存、metadata、块设备/危险伪文件、格式化/删系统根、fork bomb/无界kill-all、隐形/双向字符、无法完整展示的命令均拒绝，模型/历史/目标不能覆盖。

| 授权 | 不变量 |
| --- | --- |
| Sandbox | 默认/workspace，仅主Agent workspace/HOME/env；附件映射优先且只读，后台登记参与空闲生命周期。 |
| host | 只once/deny；未批、超时、通知失败不调用Manager。批准绑定工具名、规范原参数、target、canonical路径、主sandbox identity；Manager最终绑定根映射，仅消费一次，路径漂移后批准不可复用。 |
| 业务审批 | 浏览器/Skill/MCP/计划策略独立。MCP call 逐次审批；邮件发送/回复/移动/标记/存附件逐次审批且记录隐藏正文/凭据。unattended 拒绝这些动作。 |
| call id | 同assistant provider id唯一；任一预检/审批/并行前整批拒重复。每个被拒occurrence独立保留/消费authorization标记，不能按id覆盖成普通错误。 |
| grant | durable查询/提交、缓存、scope/lifecycle清理线性化；cleanup返回后旧查询/追加不能复活授权。 |
| 审计 | 批准后、执行前持久化并发聊天：完整实际argv/canonical cwd/目标/前后台/有效超时或完整文件、进程参数；执行后记结果/副作用。脱敏不能隐藏普通语义参数。 |

审计与模型历史序列化分离。tool参数始终符合活动schema，脱敏占位也符合enum/regex/path；任意JSON限制深度/条目/节点/字符串字节。历史展示envelope仅工具名匹配且字段已知时内存归一；错名、身份/未知字段失败，不删除后放行，不重写JSONL。

token/Cookie/Authorization/userinfo/secret变量值在离开执行器前脱敏，支持紧凑/等号/分离argv；嵌套shell无法安全解析则拒绝。原secret只在当前闭包，无journal/session/错误/预览副本。命令保留来自已消费审计投影；输出在入缓冲/process JSON/快照前脱敏再裁剪，不可只保护audit或隐藏全部普通输出。

Go/Python共享脱敏规则和必要条件预筛；优化不能改变匹配/最早起点/同点顺序或让普通文本直通。筛完整待定窗口，保持512字节尾窗、跨chunk、secret/URL/PEM/引号、EOF及非消费Preview，两端无独立白名单。

进程终止确认涵盖controller输出快照、持久登记、Sandbox计数/终态裁剪，返回后watch/wait不再写scope。取消/cleanup尽力终止前台；后台跨Run须登记、有界输出、admin可见。停Sandbox杀容器进程但保留挂载；责任协议见[Runtime](agent-runtime.md)。

## 管理器与更新

配置/control/manifest/journal/registry凭据owner-only，完整身份及请求资格先于副作用：

- 静态命令表先解析完整argv，未知/重复参数或locator、相对/非规范路径在读状态前拒绝。config规范绝对、当前UID控制、非symlink普通文件，只开一次固定inode/字节供paths/锁/watchdog/application共享；运行/proc/self/exe、stable inode、登记摘要不一致拒绝，不按basename/环境重推。home规则见[布局](../reference/data-layout.md#唯一根目录)。
- takeover journal持久化即启动边界，不等unit禁用。任何写application/ack/recovery/listener前非阻塞协调recovery flock、安全枚举owner-only无symlink recoveries；未知/坏/不安全、多非终态、身份/配置漂移零副作用拒绝。空闲lease持至listener及pending activation结算。
- pending Candidate在watchdog原子commit前仅不可变、control认证的/v1/identity，之后原子切full API；external recovery probe同样仅身份。完整idempotency、Gate、checkpoint、takeover/terminal证明见[自动更新](../operations/auto-update.md)，不能凭锁忙/历史路径扩大能力。

### 锁与 socket 所有权

| 锁 | 边界 |
| --- | --- |
| Platform实例 | SQLite/worker/副作用前取得并持生命周期，精确inode/link/权限规则见[布局](../reference/data-layout.md#权威数据与文件安全)。 |
| serve.lock | binary root内owner-only、当前UID普通文件严格权限、NOFOLLOW/CLOEXEC、非阻塞独占，application前至完整服务结束。第二serve不能降为probe；新root安全建0700，既有state root仅同UID/无symlink/他人不可写时可收紧。 |
| 锁序 | serve.lock→recovery.lock→plan lock；外部recover-current不取serve锁，可停旧owner后保持recovery锁启动精确probe。 |
| `<socket>.lock` | 同验证 control 目录，目录 fd+openat(CREAT/RDWR/NOFOLLOW/CLOEXEC,0600)，path/fd inode 一致、当前 UID、严格权限、普通/nlink=1、非阻塞独占。跨 Manager root 也串行；从 probe 持至自身 unlink 及 listener close，锁文件不删。 |

有bind锁后才探测同UID既有socket：有界连接成功=live，只有ECONNREFUSED可删除；unlink前再验device/inode/type/uid。超时/权限/模糊错误拒绝，teardown只删自身inode，不删继任者。

原子tmp清理仅写入器精确安全名称，不泛认前缀。根从已验config+固定子目录派生，拒根外version；父/叶path与fd一致、当前UID、普通非symlink/nlink=1、无持久引用才fd-rooted单文件unlink，异常留证报错。无覆盖全部writer的独占证明须等宽限，recovery锁不能排斥不取它的watchdog。启动只扫随后严格验证的operation/recovery/引用version，新鲜无关项留维护；正式身份仍拒tmp引用及缺失/坏/未知工件。

## 文件与附件

共同读取规则：逐段固定可信根/父fd，不重解析可换链字符串；普通文件用**NOFOLLOW+NONBLOCK打开，同fd验类型/身份后读**，FIFO不能在拒绝前挂死，任一初始化失败释放已持FD。数据/workspace/Runtime/env根属部署UID、无symlink、权限收紧，每次复验，缓存不豁免。

DB/WAL/SHM、实例/bind 锁、Runtime todo/process sidecar、Skill 正文/支持文件、MEDIA 来源、可删 tmp、迁移源明确要求单链接；其它对象遵循各自契约，不能泛化所有 workspace 文件的硬链接策略。

| 操作 | 附加规则 |
| --- | --- |
| Sandbox枚举/搜索 | 从固定fd读名称、相对父fd逐项打开，据fd元数据读/递归，不按显示名重解析，不跟symlink/读特殊文件；最低与当前Go行为一致。 |
| host | 先绑定批准路径的可信根/相对路径，禁Docker、Manager状态/标准config/run/凭据及操作禁区；祖先搜索跳保护子树。patch同父fd读/临时写/原子换，terminal从固定cwd fd切换。 |
| patch分配 | 先防溢出计算结果大小再分配，不能小请求放大成超界中间结果。 |
| mail附件创建 | workspace fd逐段DIRECTORY/NOFOLLOW；mkdirat后重开验owner/type；叶CREAT/EXCL/NOFOLLOW、普通/owner复验、0600、持久化。失败只清同父本次inode，拒lstat后按全路径open。 |

### 原子发布

私有目录rename和exact-final重试均fsync **child→staging/source parent→destination parent**，staging消失/空residue清理不省略。只有final仍预期inode且missing→rename或已建立的空目录恢复身份仍为空，屏障失败才可判committed-but-not-durable；重试全屏障。内容/type/mode/inode漂移不算提交、不删证据、不继续DB。

普通私有文件发布/重放同样重固定目标并fsync文件/父；相同字节或只读验证不能替代marker/sidecar曾失败的耐久屏障。Camoufox fresh资格见[布局](../reference/data-layout.md#runtime-与集成服务)。

### 上传、交付与预览

| 边界 | 不变量 |
| --- | --- |
| 上传 | 数量/单文件/总量/账号/全局配额，名称/MIME规范化；multipart增量owner-only staging，仅边界小缓冲，完整类型/摘要/配额验证后流式提交，所有终态清理。独立有界并发，超额拒绝；接收不持写准入，仅最终验证/复制/消息+job短持，更新先预约可中断。无墙钟总超时，字节空闲/断线/取消/更新/越界终止；慢滴流不能挡更新，进度只示实际发送量。 |
| 附件权限 | 仅允许位图内联模型，其余只读当前scope挂载；文件名仅显示/下载头，不是路径，Platform数据路径不入普通metadata。 |
| MEDIA | 仅 run.completed 可复制/建附件，failed/cancelled/needs_review 标记仅诊断。Platform 不挂 Sandbox `/workspace`：逻辑后代由服务端当前 scope 映射至其可见 workspace，来源限此根/受管媒体/显式媒体根，拒猜 owner/其它 scope/偶然路径/穿越/控制符。逐段目录 fd+NOFOLLOW、单链接普通叶、大小与读取同 fd，并发置换拒绝；文件/HTML 预览复用。标记保留见 Runtime。 |
| 下载 | 同源鉴权、attachment disposition、nosniff，不内联HTML/SVG/Office。空/octet-stream MIME仅确定性允许后缀映射，不依赖mime.types、不覆盖其它明确类型、不替代内容验证。 |
| 文档解析 | 仅XLSX/DOCX/PPTX/PDF。Office验后缀/MIME/ZIP身份、加密、条目路径/数量/单项与总展开界，拒绝对/穿越/symlink条目；PDF验%PDF-、拒加密。仅有界表格/段落/幻灯片可见文本/已有PDF文字，无OCR、公式/宏/脚本执行、外链/字体/关系/嵌入加载，不交浏览器原生查看器。 |
| 预览响应 | 私有nosniff JSON，kind、分页/分表、截断标记；坏/加密/无文本返回有界通用错误，无载荷/内部路径/解析诊断，不改下载。HTML/HTM单独沙箱呈现，不当Office JSON。 |

## 凭据与敏感数据

Platform secret store 拥有 OAuth、session、Agent-tool、Runtime、Firecrawl、Telegram，邮箱密码另在凭据行；Manager 文件拥有 registry 与独立 control/executor token，二者不整库互注。API 仅“已配置”；**无应用层静态加密**，靠宿主权限，不得宣称加密存储。产品 secret 不回退环境；fresh 可一次存 Manager 注入 session secret，之后只认持久值。secret 禁入文档、日志、Run metadata、release manifest、operation journal、Git。

OAuth账户目录∩Runtime锁定Pi的provider/API/endpoint/模型能力才可执行，推荐用交集账号顺序，不硬编码旧模型/退役名单或放行未知ID。取Token绑定provider+model+scope并实时复验，辅助独立复验；无session/metadata/事件/错误副本。容器仅所需secret，Sandbox不继承平台/Manager/registry/宿主环境；子进程最小环境，不整体透传。

MCP环境值是用户选择的workspace数据，用户/Agent可读，Platform不当托管secret、不复制其它存储/提示/日志。有限JSON、argv无shell、当前workspace cwd、环境仅本次短命子进程；缺配置为空，坏/越界/协议/超时/输出越界失败，不找HOME/.claude。call审批脱敏后完整展示，禁深度/数量截断；键/值隐形/双向或超展示界先拒。Manager审计/保留/预览与Platform工作记录仅action/server/tool，不存可逆客户端载荷/原输出；server描述/annotations/结果/错误不授后续权限。

## 品牌输入与公开读取

admin写+单调revision；公开仅名称、Agent名、规范主色、同源Logo URL、revision，无通用settings/时间/admin/路径/secret。名称限长、拒控制及Unicode行段分隔，入提示为闭合数据。

Logo仅单张PNG/WebP：admin PUT持久化前完整解码，读正文/开解码器/解码后复验256 KiB、单边4096、总16,777,216像素。拒SVG/URL、截断/header-only/无IDAT、动画/多帧/重复bitstream、声明错/尾随/零尺寸/超界。匿名GET不解像素，仅严格base64、1..256 KiB、大小/SHA-256对metadata；损坏报服务端错误，白名单MIME+nosniff+ETag/公开缓存。Logo/revision同事务，公开快照不混版本。

## 不可信内容与提示词注入

用户/频道/品牌、网页/浏览器/HTML、邮件/MCP、记忆/历史/计划、Skill附件均不可信。Runtime统一重建文本块、闭合防伪边界/中和伪token，保留图片；短文/成功/错误/历史无豁免。旧web/browser/memory/mcp/session/session_search/search_files/schedule/skill结果缺envelope时仅内存重建，不改JSONL；仅Runtime当前标记Skill主指令有受控低优先级流程语义。

系统提示分层只决定顺序/cache/framing，不授权；scope/lifecycle/target/审批来自闭世界结构和权威状态。prompt_cache_key仅版本化策略+tool schema+scope分片单向摘要，线上无原账号/scope/session/path/正文/secret，材料不写日志；不是身份/隔离/授权/完整性边界。todo正文不可信、非secret store，仅Runtime id/state可作机械守卫。

memory/Skill主指令/schedule prompt在写与加载/执行双边扫描：有界NFKC、隐形/双向、明确覆盖/角色劫持/提示泄露/凭据外传，不宣称全检。Skill全部内容写拒真实token/PAT、完整PEM私钥/实际Bearer，不能因说明/占位/无密钥示例误拒。

邮件唤醒仅只读mail账户/目录/搜索/正文及汇报，其余执行、文件、网络、浏览器、Skill、schedule、delegate、MCP、mail修改/附件保存调用前拒。review唯一Skill免审路径，Runtime tool+Platform action双白名单；完整主体、私有provenance、先读、lifecycle事务及预算见[学习复盘](data-memory-sessions.md#学习复盘)，文本不能伪造或取得其它执行/网络/凭据能力。

## 电脑画面与呈现页

只读scope投影非执行入口；文件/搜索有界脱敏纯文本，host正文/草稿不进预览。Codex草稿仅解析后累计参数，不转原始JSON fragment；未终结版统一脱敏+安全尾窗，Platform再脱敏/限大。登录派生scope并匹配当前Run/sandbox call/相对路径；[数据设计](data-memory-sessions.md#即时派生预览)定义寿命/禁持久化。

HTML仅当前scope成功落盘HTML/HTM或授权附件，认证nosniff `/api/agent-previews/present` 单页返回，文件用 `/file`。iframe sandbox **无allow-same-origin**，无产品Cookie/父DOM；CSP禁父连接/表单/网络，仅data/blob及必要内联脚本样式。无workspace静态资源服务，相对外链失败预期；不授Camoufox接管/剪贴板/任意地址栏。

## 浏览器接管与局域网

租约仅当前scope/tab，登录派生Camoufox身份；客户端无user id/selector/脚本/内部URL，仅限幅鼠标/滚动/文本/按键。拖拽点数/时长有界、时间单调、CSS坐标，单sequence原子校验执行、重复不重放、异常finally mouse.up。

root scope租约取得/释放、人工输入、Agent修改同串行门覆盖真实Camoufox调用；租约中Agent修改返回可重试冲突。触发Agent的新消息先等前端输入队列，再同门**入队前仅撤发送者本人的匹配root租约**；普通频道消息/他人租约无此能力。

结束/失焦/隐藏/到期/tab变化关闭/409立即只读并尽力取消释放，服务端到期/cleanup兜底。画面逐请求鉴权/维护门/大小界同源二进制GET，不增绕Manager长连接；共享X display禁VNC/noVNC。

LAN默认关，仅明确私网/回环IP，拒通配/公网；RemoteAddr+显式CIDR准入，丢不可信转发头后重建。推荐DNS/TLS反代Manager回环；显式明文显示风险、不声称secure-context通知。

## 安全变更要求

安全边界变更先更新对应规范并保留真实滥用/恢复验证。跨层值引用[runtime-policy.json](../contracts/runtime-policy.json)、[container-platform.json](../contracts/container-platform.json)，验证入口见[测试](../development/testing.md)。
