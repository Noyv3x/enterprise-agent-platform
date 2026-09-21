# Agent Runtime 设计

本文拥有 Run、工具循环、守卫、委派和上下文算法；wire 归 [Runtime API](../reference/runtime-api.md)，跨层契约归下文链接的所有者。

## 所有权

Runtime 直接使用 lockfile 锁定的 Pi Core/Pi AI，不经外部 CLI 或源码子模块执行；它管理 Run/journal、工具策略、JSONL session/压缩及可执行模型目录。Platform 拥有产品业务状态，Manager 拥有 Sandbox/host 执行与容器；Runtime 不复制这些状态，也不访问 Docker socket。

进程和文件工具仅走 Manager executor，不保留本地或测试专用后备。生产客户端与 fake 均必须实现 `ExecutionManager` reconcile/ack，遵守同一耐久顺序；无 task 可返回空 evidence，但不能跳过接口或将未确认 tombstone 视为成功。仅提供 memory/skill 的复盘不进入 task 对账。

## 提示词组装与执行纪律

确定性组装**单个** provider system prompt，顺序固定：

1. **Runtime 稳定策略**：仅当前 Run/能力所需的执行、回复、记忆、Skill、追加输入和计划策略；同能力字节稳定，不含时间、召回、sidecar、技能索引。
2. **Platform `system_prompt`**：稳定身份、模式、工作区在精确时间前；品牌、用户和频道载荷闭合为不可信数据，不从正文推权限或身份。显示名、说话人、风格归[对话模型](product.md#对话模型)。主 Agent 获逻辑工作区及可信部署派生的宿主映射；后者仅供理解，不改默认 target，不入公共状态、数据库或普通工具 metadata。
3. **Runtime 动态状态**：记忆、活动 todo、有限 task、Skill 索引；正文、历史、元数据不可信，Runtime-owned id、状态和责任权威。普通 Run 无空动态块。

单工具软策略入稳定 schema。禁止按长度、关键词、provider、工具次数推复杂度或自动建 todo。独立且允许并行的工具按 Pi `executionMode` 并发；含顺序工具的批次有序。提示要求适度自主、工具实证、失败替代、完成前验证，不扩权、不强加未选计划。

Codex `prompt_cache_key` 是版本化内容摘要，覆盖稳定 Runtime 前缀、provider 实际发送的**有序**工具 schema 与 scope 稳定分片。对象字段可规范化，工具数组不能排序；动态数据不改 key，策略、能力、工具顺序或 scope 变化时确定失效，不把多租户流量压入同一热点。`session_id` 仍用于会话、header 和 WebSocket 续传。三个逻辑层不是三个缓存块，key 仅是亲和提示；缓存未命中、被忽略或回退完整上下文都不改变语义、授权和结果，缓存可用性不是 readiness/发布条件。当前 Codex OAuth 没有经过 canary 验证的显式 cache breakpoint，不得向私有端点猜加公共 API 字段；单元测试不能证明真实缓存命中。

## Run 状态机

顶层 FIFO：`queued → running → completed|failed|cancelled|needs_review`。仅顶层占全局槽；子共享父槽、Sandbox 和工作区，但有派生 scope、独立 session/事件。

- 非空幂等键在 scope 内唯一；重复创建复用，持久终态可重放。重启时已开始无终态的幂等 Run 置 `needs_review`，不重做。
- queued/running 不按终态 TTL 裁剪，终态从提交计时。授权、幂等、输入先落盘后发布，禁止可重放却不执行的幽灵 Run。原子替换后的耐久错误是不确定提交：实例失败关闭，旧快照不得覆盖；重启读权威文件，waiter 与槽仍须收敛。
- 私人顶层交互可追加；仅 `injected` 消费，`accepted` 不算。稳定 id、`unconsumed` 保序回原 durable 队列且不伪报成功、撤回仅隐藏等事务归[数据设计](data-memory-sessions.md)。
- 邮件唤醒 job 的来源引用归[数据设计](data-memory-sessions.md#持久任务与追加输入)；Platform 在 dispatch、重启或中断恢复时，仅在内存重建有界预览任务后提交 Runtime。Runtime 不从 job key 或正文推账号/scope。

单次模型请求**尚无非空正文、思考或工具调用增量**时，才可对过载、限流、可重试服务端或瞬时网络错误做有界指数退避加抖动。已有增量，或上下文/输出大小、额度/账单、认证/内容策略错误均不重试。工具后下一请求可重试，不重开 Run、不重放轮次或工具。退避可取消并刷新活动；耗尽按副作用置 `failed|needs_review`。browser 视觉辅助仅用自有有界 timeout 和文本 fallback。

## 模型目录与授权

Runtime 按锁定 Pi 元数据校验 provider/API/endpoint，请求不得覆盖。账号与能力目录交集、逐模型授权及默认/辅助选择的唯一规范是[模型 OAuth](integrations.md#模型-oauth)，wire 见[模型目录](../reference/runtime-api.md#模型目录)。本文不固定模型 ID、版本或优先级；Token 不入 metadata、session 或事件。

## 工具与执行目标

工具名/action 以[当前 schema](../../enterprise-agent-platform/agent-runtime/src/tools.ts)为准；不转换旧 browser action、参数别名或展示用 `tool` 字段。

- terminal/process/文件默认 `sandbox`，target 仅 `sandbox|host`。Platform 指派主 identity，子只能继承；Manager 执行规范化请求、返回有界结果/句柄，模型不获控制 socket 或容器身份。
- 宿主 workspace 沿用[物化准入](data-memory-sessions.md#agent-scope)。Runtime 不创建、修复或推断；缺失、旧格式、漂移均失败关闭，更新与恢复亦同。
- 审批、重复调用整批拒绝及逐条标记、grant 清理、fd-pinned 路径、成功/错误 framing 与图片保留，完全遵循[安全设计](security-and-trust.md)。
- 历史 arguments、审计 envelope、内存归一按[Journal 提交](data-memory-sessions.md#journal-提交)；脱敏仍须符合活动 schema，错工具名仍拒。browser 任意 JSON 提取同时限制深度、节点、条目和字符串。
- Skill/MCP 配置、安装重定向、即时读取、采用及文档交付归[集成](integrations.md)。显式读取新配置不改本轮已发 schema/前缀。

附件内联、只读挂载和成功交付遵循[安全契约](security-and-trust.md#文件与附件)。Runtime 不读 Platform FS，不对中央容器外宿主路径 `realpath`；文件先写工作区，再完整行 `MEDIA: /workspace/<relative-path>`。仅 Platform 授权转附件，不能以任意宿主路径或文件名替代。内部复验间只保留完整一行、具有受支持后缀且不含路径穿越或控制字符的规范标记，不保留临时回复的尾随说明；相关变更全部验证清除后，才去重恢复这些标记至最终 output。保留标记不授予文件权限；复验失败或仍有未确认变更时不恢复，非成功 Run 不交付。

Codex 草稿遵循 [SSE journal](../reference/runtime-api.md#sse-journal)，不形成执行或副作用授权。时间线、电脑槽位、HTML/文档预览归[前端](frontend.md#电脑画面)，不新增 Runtime 呈现、桌面或静态站点工具。

### 完成守卫

| 硬责任 | 解除条件 |
|---|---|
| 模型已建立的 todo | 全部为 `completed` 或 `cancelled`；真实 blocker 不得把未完成项变成完成 |
| 有限 task | 当前 session 得精确进程权威终态并耐久确认 |
| 顶层 recurring occurrence | Gateway 成功执行当前 occurrence 的 continue/complete |
| 成功委派已开始副作用 | 父在委派后成功做非委派聚焦验证 |

硬责任有界延续后未解即 `needs_review`，无其它副作用亦同。todo/task/recurring 留最后非空、非临时指令的真实 assistant 进度为有界诊断，并给独立 blocker；正文不使 Run、幂等结果或 durable job 成功，不恢复 `MEDIA:`。

**软延续不持久、非硬责任**：本 Run 普通文件变更仅一次聚焦验证提示；无行动的承诺终稿、有工具结果却空终稿各至多一次。均有界，不写 session，不重发已有可见增量的请求，不重放工具；耗尽按真实输出/状态收口，不凭启发式升 `needs_review`，不造证据。

`todo` 仅用于至少三个独立可追踪步骤或多个可分别完成的任务；简单回答、一两个动作、同一小改动的读取修改验证不凑清单，工作变复杂后可再建立。支持读取、整体替换和稳定 id 合并，至多 256 个有界项，状态为 `pending|in_progress|completed|cancelled`，同时只保持一个 `in_progress`。工作确已完成并经适当验证后立即标记 completed，放弃的工作标记 cancelled，只追加新发现的必要工作。Runtime 不自动建清单，空状态不注入 todo 策略。权威 sidecar 不从 seed、用户正文或未配对工具历史恢复；压缩只重注活动项，终态项留作审计，真实 blocker 对应活动项供同 session 后续 Run 恢复。

计划仅用于未来时间，不做 watcher。可信 recurring 顶层 occurrence 须空参成功调用 `schedule.continue_current`（原子复验、保留下次、不改计划）或 `schedule.complete_current`（原子结束所属计划、作废旧排队项）；无目标 id 或其它计划权限，不猜正文。once dispatch 后自动结束、无此守卫。决策与 `needs_review|blocked` 当前 revision/last_run_id 原子暂停归[计划 occurrence](data-memory-sessions.md#计划-occurrence)。

## 有限后台任务

有明确终点且可在工具上限内结束的工作优先前台执行，并给予足够的 `timeout_ms`；整个有界执行生命周期保持 Run 活动，不能仅靠心跳与 watchdog 竞争。需要独立句柄的长任务，或用户明确要求独立存续的服务，才使用后台模式：

| `background_kind` | 责任 |
|---|---|
| `task`（缺省） | 确认终点；owner-only 原子 sidecar 登记 scope/lifecycle/session、process id、target、登记时间 |
| `service` | 不登记完成责任、不阻塞 Run，仍须检查就绪 |

分类仅 Runtime 使用，前台禁带；Manager 只收派生 `completion_required` 和不可逆 session owner 摘要，不收原文。**仅同 session、同 id/target 的 `process.wait|read|kill` 返回 `completed|failed|cancelled` 是终态证据**；其它操作/状态、超时、重启或前次 `needs_review` 不解除。责任跨 Run 可信恢复，损坏或身份漂移失败关闭。

**耐久顺序不可换**：

1. Manager completion-required intent 落盘 → 启动命令。
2. 每个普通 Run 读 sidecar/启模型前，以精确 scope/lifecycle/execution context + owner 摘要 reconcile，原子补责任；未确认 task 的活动/终态记录不按 TTL/数量裁剪。
3. Runtime 获得权威终态后，先原子写 `active → resolved` tombstone，再请求 ack；只有收到 Manager 的成功 ack 响应，Runtime 才原子删除 tombstone。Manager 在服务端持久确认 ack 后即可将该终态纳入普通裁剪，不等待 Runtime 收到响应或删除本地 tombstone。
4. 崩溃只重试观察/ack，不重跑命令、不假成功；前台/service 不入集合，host task 同规则。

要结果用 `process.wait`，禁 interval/cron 轮询。session 有活动 task 时，preflight 在 Platform 调用或审批前拒 `schedule.create`，全解除后恢复；service 不触发禁令。wait 绑定 scope/lifecycle/target/id：终态回同一有界快照，超时回 running 且不停止进程，取消只中断等待；读、等、预览不消费终态。wait 暂停 idle guard，不扩模型轮次或进程 deadline；Manager HTTP deadline 覆盖有效 wait 加固定传输余量。

重启不以 PID 消失猜成功。Sandbox wrapper 原子保存 shell 的真实 exit code 后退出，终态文件绑定进程记录；格式、类型、范围有效才恢复 `completed|failed`。缺失、损坏、symlink 或不可读时为未知 code 的 `failed`；停机未确认则 `orphaned`，文件随记录裁剪。host 控制器随 Manager service 存续；正常退出存真实 code，异常重启丢控制器从预提交 intent 恢复 `failed`/未知 code，经同一 reconcile 返回，绝不重启命令。

## 会话与压缩

session 是模型 JSONL，不是登录 Cookie；身份、持久化、archive、sidecar 完全遵循[数据设计](data-memory-sessions.md)。初始化、追加、压缩、删除不另开同路径队列、不越事务。

自动与手动同算法：

1. 按合法 user/assistant/tool 边界保护近期 tail，通过当前已授权模型的有界、无工具摘要请求迭代单个结构化 handoff。每次新增消息重算现役投影阈值，同 Run 再超再压，已有摘要不豁免。
2. 字符预算先保最早目标/验收与最新待省略用户请求的首尾锚点，余量倒序给近期工具证据。handoff 保留未完请求、验收、已做动作/证据、决策/约束、文件/关键结果、blocker、下一步及活动 todo/process；旧 handoff 不可信，不堆叠、不归档。
3. 输入与输出共用清洗器，覆盖 Token、认证头、JWT、私钥、密码连接串、敏感配置和 URL 参数。摘要不反写访问边界内的保真 journal/archive；历史和摘要不授权。
4. 仅正常结束、无工具调用、清洗后完整正文非空且在独立上限内才提交。`length|toolUse`、错误、中止、超长或截短前缀均失败，保留原状态及此前安全提交。
5. 按数据规范 archive-first 提交省略真实消息；仅一个 Runtime-owned 结构标记摘要，不按正文识别；todo 独立可信重注。恢复中断孤立 tool call 时修复并发 `session.repaired`。`session` 查 journal+archive，Platform `session_search` 查跨产品会话，结果皆不可信。

阈值与终态 `context_usage` 同边界：优先本 Run、同请求前缀的有效 provider 用量（已含系统提示/工具，不重加），新消息另估；无锚点则估消息、完整提示及本轮工具名称/说明/schema，不计图片 base64、执行器或审计字段。恢复、换 Run/模型、压缩或前缀变更后，旧 usage 仅供审计；新测量前估 handoff+tail，不算 archive。含估算即近似，不保证精确 tokenizer 或永不溢出。

`/compact` 是控制操作，不建 Run/命令消息、不删 archive。精确身份有 queued/running 则拒绝；无安全可省略历史则成功 no-op，不造消息，重复调用不增长 journal/archive。门闩隔离同身份新 Run。独立长摘要 deadline 或断线在最终提交点前取消，确认摘要停止后原样释放；过提交点忽略迟到断线，完成有界 archive-first 提交再释放。压缩与删除共串行边界及 cleanup fence：不能持阻碍压缩收敛的锁等待，不能在删除后以旧快照重建文件。

## 记忆与技能注入

memory/user 的隔离、召回、注入、正式记忆内容和免审写资格均遵循[数据设计](data-memory-sessions.md)。Skill 仅注精简索引，正文/支持文件按需加载；路径、安装和安全整理工作区归[集成](integrations.md)。

## 学习复盘 Run

完整 Platform 身份及保留 session/幂等命名空间见 [API](../reference/runtime-api.md#创建-run)，排队/session 初始化前校验；普通 Run 不得预占或拼字段提权。job 准入、取消、逐读写复验、轨迹和跨重启预算均遵循[学习复盘](data-memory-sessions.md#学习复盘)。

前台交付后用独立临时 session 和有界近期历史；不接受追加、不委派、不展示流、不写父 session，终态精确删临时 session。turn 上限 `min(16, maxTurnsPerRun)`，不得调高普通上限扩大免批写。仅 memory/skill 工具：memory 读及 `store|replace|forget|reconcile`，禁 clear；skill `list|load|read|create|patch`，现有包须先同 Run load/read，patch 仅 unpinned、active、agent-owned 包。读免费，reconcile 每子动作与其它变更共 Platform job 预算，提示/schema 须明示，不能整次计一。Gateway 传完整可信主体；复验、模型或清理失败不改前台回复、不递归学习。

## 委派

- 单任务或有界 `tasks[]` 限并发、按输入序合并，父须等全部子终态。深度和总创建预算由可信内存树定位根、原子共享，metadata 不得重置；全局活动子 admission cap 满即拒绝，不排队持槽互等。
- 默认 leaf 无委派工具；仅父显式选择且预算允许才用 orchestrator。系统提示与安全继承 Platform 可信父上下文，父模型 `prompt` 仅用户任务数据，不替换或追加子 system。
- 子 scope/session 独立，继承 Sandbox/workspace/HOME/env，临时记忆和浏览器按子 scope 隔离；并行不得改同文件或共享外部对象。模型、工具、wait、压缩活动传父，父取消传全部后代。
- 子终态清理派生 scope/session；故在副作用、审批、Manager 请求前拒一切 `background=true`（含 task/service），命令必须前台等结果。
- 成功子结果仍待复验；Runtime 生成 child id、副作用、已知文件或未知变更证据，不解析模型文字。只读不加责任；成功且有副作用须父在该委派后成功做非委派聚焦检查：已知文件用读/search/针对路径的 terminal，未知或外部变更用综合 terminal。口头确认无效，新批副作用作废旧验证；有界延续后无证据则 `needs_review`。

## 停止与恢复

取消、scope cleanup、Manager 执行断开、idle guard 中止模型与当前前台工具，并等有界清理；有副作用且安全终止不明则 `needs_review`。普通 Run 无固定墙钟上限；idle/turn/terminal/wait 见 [`runtime-policy.json`](../contracts/runtime-policy.json)，其它限额见[配置](../reference/configuration.md)。正常完成不停独立 service；task 未见终态不得成功。

**仅 todo/task/recurring 守卫 `needs_review` 可留 task**：取可信 sidecar 中本 Run 仍活动的精确集。Manager 逐项复验 run/scope/lifecycle、受管后台身份、数量/格式，任一不符即失败，清理同 Run 其它进程。显式取消、idle timeout、scope cleanup、普通失败、sidecar 不可验均为空集；模型不扩集，service 不借守卫保留。

Manager 独占进程清单和 family 并发上限；family 仅 root 本身及 `root + "/delegate/"` 后代，不含相似前缀，单进程需精确 scope。root cleanup 不靠内存 execution-context 缓存，依次：

1. Runtime 封锁、取消匹配 Run/审批；Manager 安装 family/lifecycle start fence 拒新 start，等已准入 start 登记或无副作用退出，才快照、预检 evidence 上限、停止。fence 必须保持至 Manager cleanup 返回，不能在取得进程快照后提前释放。等待不持登记锁、不阻塞其它 family/lifecycle；重叠 cleanup 共享闭合结果或有界拒绝。
2. 全部进程和控制器收敛后，Manager 回有界闭世界未确认 task 身份并 pin 记录，不先 ack/裁剪。
3. Runtime 在责任存储串行边界删该 family/lifecycle task sidecar；普通 cleanup 留 journal/todo/session，`delete_sessions=true` 删整个 session family。**本地提交 → 逐项 ack → 全成功才删内存 context**；任步失败不报部分成功，重试仅对账既有进程和剩余 evidence。

cleanup/kill 回复前，输出快照、持久状态、Sandbox 计数、终态裁剪须收敛；之后旧 wait/watch 不再写 scope。每进程唯一结算/Wait 回收者，前台 EndCall、后台计数、持久提交先于完成信号。准入落盘失败不留假计数；未结算或 `running|orphaned` 不裁剪；PID 未就绪（含空文件）仍受 deadline/等待间隔约束。host 前台取消/deadline 停整个自有进程组并等结算，不只杀 shell；stdin 写串行可取消，取消输入等待不杀独立后台服务。计数查询不复制输出，预览先筛 scope/展示集合再读有界输出；展示/revision 见 [Scope 与进程](../reference/runtime-api.md#scope-与进程)。

## 验证稳定性

命令/证据标准见[Runtime 验证](../development/testing.md#agent-runtime)；runner 抖动不得放宽产品时序/终态契约。
