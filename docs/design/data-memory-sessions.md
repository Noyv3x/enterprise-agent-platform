# 数据、记忆与会话

本页定义权威状态、事务、CAS、任务与学习生命周期。精确路径/marker/迁移见[数据布局](../reference/data-layout.md)，认证/文件安全见[安全设计](security-and-trust.md)，Run/压缩算法见 [Runtime](agent-runtime.md)，wire 字段见 [Runtime API](../reference/runtime-api.md)。

## 数据所有者

| 所有者 | 权威状态 |
| --- | --- |
| Platform SQLite | 账号/权限、频道/产品消息、附件元数据、token 用量、scope、memory、settings、外部身份/凭据、Telegram/mail、durable job、追加输入、schedule occurrence。 |
| Runtime | 模型 JSONL/archive、approval/idempotency、todo/有限进程责任；不替代产品消息库。 |
| 主 Agent workspace | 用户文件、Skill 包、MCP 清单/server/用户环境值，不另存 DB 配置；Skill 授权在 Platform-only 状态。 |
| Manager journal | generation、预约、更新/恢复编排。Platform 仅按匹配 operation id 取得/释放准入，不从容器/DB/文件消失猜测完成。 |

SQLite 使用 WAL、外键、按线程连接。事务正文或 commit 失败（含 insert）后，复用连接前必须尝试 rollback；已报错写入不能由后续请求提交。文件+DB 组成可恢复逻辑事务，启动清未完成附件/孤立文件。

全部业务表是原子 baseline：空库建当前结构，非空库精确验 marker、表/列、约束、索引、外键；未知/缺失/退役结构先拒，不允许 store 启动补表。仅[受控迁移](../reference/data-layout.md#受控迁移)接受直接前版本；可重建 FTS 例外不是业务修复。

凭据、HMAC 登录失败窗口、session secret、工作记录随同一 SQLite 快照/提交/回滚，禁止两 generation 同时写；更新不能清失败计数，沿用 secret 不使未过期/未吊销 Cookie 失效。Cookie 不入 DB/JSONL；窗口只存有界不可逆主体/时间戳，详细认证由安全设计拥有。listen host/port 不属业务设置，环境不是第二份 secret 库。

## Agent scope

- 私人 `private:<user-id>`；频道 `channel:<channel-id>:main-agent`。logical `agent_scopes.lifecycle_id` 与当前 conversation 的 Runtime lifecycle 可独立轮换，**不要求相等**；marker 绑定 logical key/type/id 与 Runtime lifecycle。
- session 映射仅由 `agent_runtime_scopes` / `agent_runtime_scope_sessions` 承载，alias 保留历史 lifecycle/session；委派继承父 sandbox/workspace。新建/轮换 session 前缀固定 `agent-platform-private-u<id>` / `agent-platform-channel-<id>-main-agent`，品牌不重写历史。
- logical 身份可先于执行登记，但当前已登记 workspace 的规范目录、marker、alias 在启动前必须存在且一致；启动/普通更新/缓存不补缺失或漂移。每次验证相对身份及路径，详见[布局](../reference/data-layout.md#workspace附件与-skill)。
- 停用保留 workspace/session/memory；产品隐藏不销毁上下文。真正 reset 必须显式 lifecycle/session rotation+scope cleanup，不能从消息可见性推断。

## 产品消息与 Runtime 会话

产品消息用于界面/审计/投递/搜索/回复关联，Runtime history 用于模型上下文/工具配对/压缩；只能通过 source message、Run、scope、lifecycle、session 关联，不能匹配正文猜身份。

管理单删/时间删/清空和本人频道撤回都是**逻辑隐藏**，不轮换 session、不清 Runtime/memory/附件/workspace、不取消已排队/运行回复。撤回仅本人可见持久用户消息，乐观临时行无服务端语义；[授权](security-and-trust.md#认证与权限)单独复验。当前无物理 purge；未来须以版本化操作共同设计消息、附件、job、scope，不能复用隐藏。

**删除频道**不同于隐藏消息：使用既有 `channels.archived` 持久阻断访问与新任务，同时终结排队/运行任务，等待 Runtime/Manager 的 scope cleanup 确认，不删除 session、workspace、附件或审计，不轮换身份。管理员/经理的 `manage_channels` 在串行提交边界复验；发送、入队、恢复和迟到发布都须拒绝已归档频道。清理失败返回错误且频道保持不可用；同频道删除可重试清理，不能伪报成功或重新开放。无需新 schema、物理 purge 或恢复协议。

`DELETE /api/channels/{id}` 成功返回 `200 {"deleted":true,"channel_id":<id>}`；无对应记录为 404，无管理权限为 403，未确认清理为 503。已归档记录允许同权限重试并返回相同成功结构；保留名称唯一性。

`/compact` 是控制操作，不写产品消息/伪用户输入；只归档并原子改写当前上下文，产品消息/附件/memory/workspace 不删。内部 handoff 用 Runtime-owned entry 顶层标记识别；无标记的同文真实用户消息仍须归档。

### Journal 提交

| 边界 | 不变量 |
| --- | --- |
| 串行 | 同 canonical journal 的初始化/header/seed/尾修复/追加/manifest/压缩提交/删除共用一条 mutation queue，不嵌套；session admission、archive、approval 保持独立所有权。 |
| 尾修复 | 健康尾仅查末字节；缺换行才有界反向查最后验证边界。完整 JSON 补换行，非法/不完整尾截断再追加，不拼残片、不每条全扫历史。 |
| archive-first | 去重并 fsync 被省略持久消息，再原子换 journal。先按写后 UTF-8 字节验 archive 上限；缺稳定 entry id 不压缩。摘要失败不改原上下文。 |
| 历史安全 | 参数始终符合当前 schema，展示 envelope 仅安全内存归一，不改 JSONL、不放宽身份/未知字段；见[审计](security-and-trust.md#工具执行与审计)。 |

`metadata.agent_work.activity` 仅真实工具 Run 的消息级工作记录，与消息分页/隐藏/备份，不另建 history/memory。detail+脱敏允许 parameters+真实有界 result 共用单项 **32 KiB**、总 **512 KiB**；正常 Run 完整保留，仅超过 **512项**/详情硬界时显式报省略项/字符数。不得复制最终答案、write/patch/mail 正文、memory/跨会话搜索结果/secret。sequence、工具原位更新、文本一次展示与 stream 缓冲由[实时对话](frontend.md#实时对话)拥有。

## 模型选择状态

部署模型空字符串为“自动”，账号空字符串为“继承部署策略”，均为持久意图；非空显式选择不因 OAuth/目录刷新/更新被覆盖，换 provider 未选新模型才清旧值。自动 Run 从可信 Runtime 能力∩账号实时目录取推荐，不猜首项、不回写，无安全推荐拒绝。目录不可用时明确值仅保留意图，不重入可选列表；实际 Token 仍实时复验，主/辅助各用自己的 provider+model+scope。目录并发见[集成](integrations.md#模型-oauth)；Token、复验结果、prompt_cache_key 不入持久会话/消息/备份，不替代身份/恢复依据。

## Runtime sidecar

todo 与有限进程责任是同 session 目录中两个独立 schema、owner-only 原子状态，精确绑定 scope/lifecycle/session；拒 symlink/hardlink、owner/权限/字段/JSON/身份异常。seed、用户正文、模型摘要不能创建权威状态；cleanup 与 JSONL/archive 一并清理，失败不能解释为空。

- todo 结果可写 JSONL，但 sidecar 权威；不是业务任务/长期记忆。压缩/重启只注入 pending/in_progress，完成/取消留审计；needs_review 不伪造完成/删除，后续同 session 继续。
- 进程责任仅 Manager id、canonical target、登记/更新时间，不存命令/输出/模型文。task 成功 terminal 先登记；同 session、匹配 id/target 的 wait/read/kill 观察权威 completed/failed/cancelled 后原子解除。timeout/running/orphaned、Run 终止/重启保留，service 不登记；活动责任可信注入，延续耗尽 needs_review。intent/evidence/cleanup 协议见[Runtime](agent-runtime.md)。

## 持久任务与追加输入

消息持久化后建 durable_jobs，每会话一 FIFO worker，全局并发仅限制进入 Runtime。领取/root 建账失败必须保留恢复所有权或明确结算反馈，不能消费唯一唤醒留下无人负责 queued/running。已提交结果不明不自动重做。

| 状态 | 不变量 |
| --- | --- |
| payload | 用户消息可存快照；mail 唤醒仅类型+source_message_id。唤醒/恢复/复核/补偿先验 job scope 与源归属，再从消息/可信 metadata 重建；缺失/不匹配拒绝，不猜去重键/正文。 |
| 启动恢复 | Agent 消息 metadata 至多顺扫一次建本轮 job/完成集合，不每 job 全扫；索引不替代 DB。消息高水位空库0、普通启动只验读，缺失/坏值拒绝，不静默设最大id跳任务。 |
| joined input | 每新消息独立 job；首次 FIFO claim 与 agent_run_inputs reservation 同事务，不留无任务所有权 reservation。账本区分 reserved/submitting/accepted/injected/unconsumed/终态。 |
| 重启 | 未提交 reserved/unconsumed 可重排；提交/注入后终态未知，输入和父 job → needs_review；确定回复只幂等核对，不再生成。 |

### 计划 occurrence

SQLite 拥有定义/revision/occurrence；Platform 派生可信 schedule 身份。recurring 仅空参数无目标 id 的 continue_current/complete_current：同事务复验 owner、revision、当前 run/job/source；continue 不改定义，complete 置 completed、禁用、清 next run。旧/重复观察不获得其它计划能力。

needs_review/blocked 与 occurrence 终态同事务：仅 **last_run_id+revision仍匹配** 的计划置 paused、enabled=0、next_run_at=NULL；迟到/重复不暂停新 revision、不重开。重叠唤醒仅追加 skipped/推进到期，不换活动 last_run_id/决策revision；用户改计划推进 revision 作废旧身份。schedule 不充当当前 Run 本地进程 watcher。

## 记忆模型

memory（事实/规则/偏好）与 user（当前用户资料）仅同 Agent 语义分区；查询、召回、人工维护、复盘均以完整 scope 隔离，同用户另一 Agent 也不可读。共享资料进入用户选择的外部系统/频道文件。

记录含 tags、manual/automatic 来源、Run/message、hash、时间；owner/写权来自可信 context。写入有配额/长度/去重/扫描，只存稳定跨会话事实，优先合并替换冲突，不存 secret、未确认推断、临时任务/TODO/路径/错误。

只有私人顶层交互 Run 免审自动写，频道/计划/mail/委派只召回。写持 lifecycle barrier，单个 **BEGIN IMMEDIATE** 复验 canonical private scope/current lifecycle、active/私人权限、来源用户消息、runtime_run_id 对应 running 父 agent job，再变更/返快照；reset/撤权/job终结据此线性化，预检不是持久授权。

FTS5 agent_memory_fts 仅派生自 agent_memories：列 content,tags_json、content_rowid='id'。启动验真实列/SQL/三个触发器，错误只重建该表/触发器并源表 rebuild；正确同步者不重复 DDL，契约错不能当“不支持FTS5”永久降级。

## 学习复盘

私人顶层交互的最终回复与主 job **均成功**才累计；回合或成功工具任一达十次，以 source message+lifecycle 幂等建低优先级 agent_learning_review。同源一 job，计数在 settings、任务/预算在 job，rotation归零；频道/计划/mail/委派/失败/中断/review自身不计数或递归触发。

近期消息与安全工具轨迹不可信；轨迹只保校验的 Skill load/read id、可选安全相对路径，无正文/patch/结果。持久信号为用户流程/风格纠正、可复用技巧、已用 Skill 缺漏；先 patch 已读合格包，无目标才建一类任务 Skill，临时环境故障不固化，无信号可不写。

### 授权与提交

完整主体由 Platform 派生：owner、canonical private scope/current lifecycle、source、running review job、mode/trigger/unattended、无 parent/delegation。Runtime 在排队/初始化前验专用 session/idempotency 命名空间并逐调用透传；[API](../reference/runtime-api.md)拥有精确字段。Gateway 每次访问前从 SQLite 复验全部主体及 active/权限，延迟旧请求先拒。

锁序 **conversation gate→scope start barrier**，不反向等待；compact/cleanup同序。组装/提交/失败共用释放边界，提交前复验且持 barrier至明确 accepted。停用/撤权/reset同门结 queued/running review、清已accepted Run；迟到 accept发现失效仍结job并取消。

| 操作 | 持续到操作结束的边界 |
| --- | --- |
| memory读 | lifecycle/review门+同一SQLite快照，复验后查询。 |
| memory写/reconcile | 同门+单BEGIN IMMEDIATE：复验、扣预算、全部变更、返回快照，失败全回滚；reconcile≤20个store/replace/forget，无clear。 |
| Skill list/load/read | 同门+BEGIN IMMEDIATE：复验、读文件、read-ledger登记，读免费。 |
| Skill create/patch | 同门先独立写事务持久预扣，再另一BEGIN IMMEDIATE复验主体，持至scope lock内文件提交结束；失败也可能收费，不能文件成功而计费回滚。 |

每 review job 跨重启/重领/重试共享 **20单位**：memory每动作（含reconcile子动作）、Skill create/patch各1，读免费，耗尽拒写；独立模型硬界 min(16,全局turn上限)，不能互代。

worker在业务回复外串行，领取/重排/终态存储短错有界退避，不能静默永久退出。已领终态不明仍阻更新，关闭交启动恢复；预约后不领新review，活动者结束/受控取消重排才切换。不产生产品消息/工作记录/通知、不改已交付回复；Runtime拥有tool白名单/临时session精确清理。

## 召回与搜索

顶层仅当前scope query recall与用户资料；空不注入，失败不阻Run；独立字符预算按完整记录裁剪，包不可信边界。session搜当前JSONL/archive；session_search仅canonical私人/频道主Agent、统一字符预算，产品行须有session_id或reply关系明确归属，不合成兼容session。

### 即时派生预览

附件原件/metadata归消息scope；Office/PDF预览仅有界即时JSON，不入DB/模型/备份，坏/加密/无文本PDF失败，无OCR、不改下载；HTML单独单页呈现。解析授权见[安全设计](security-and-trust.md#文件与附件)。

帧/租约/sequence、文件/搜索/HTML都是有界scope派生结果。草稿仅Runtime有界事件journal、Python当前SSE闭包、Platform当前Run内存；诊断副本去正文，公共状态/SSE仅路径/种类/revision，正文端点区分workspace/draft。无消息/agent_work、DB、Runtime session、workspace、memory、搜索、备份/release副本。

工具结束/失败、Run替换、lifecycle/generation切换、进程重启均丢草稿；成功后从真实workspace重建，HTML也可从已交付授权附件重建。preview只观察、不建workspace/启动服务/写文件，不新增service/port/持久目录/config/migration。拖拽finally抬键，无持久半手势；UX fence见[前端](frontend.md)。

## 技能数据

可移植包与Platform-only状态分离，[布局](../reference/data-layout.md#workspace附件与-skill)定义路径。合法外来包初扫原子补user-owned/active/enabled；缺状态安全解释user+active，不授自动权。正文/列表每次读workspace，下次调用生效；Run精简索引下Run重建。

状态以不可变skill id记录enabled、来源/时间、usage/patch、active/stale/archived、pin/归档，绑定包device/inode/ctime；删除重建/换链旧状态降user-owned。workspace sidecar/同UID模式不授权，前台/界面创建属user，只有可信review创建属agent。

- bundled全局只读；用户可同id或大小写不敏感名称遮蔽，升级不覆盖用户包。自动create/patch在提交前按id+重新解析frontmatter name拒bundled冲突，包含此前改名/本次改名。
- patch同scope lock内对单文件精确字符串+预期次数原子替换，不模糊匹配；主指令重验frontmatter/配额/注入，全部写扫描凭据。不改来源/state/pin/enabled。load记使用、patch记维护；非授权telemetry可能滞后，失败先重读正文，不盲重放。
- 自动patch仅本Run已load/read的agent-owned+active+unpinned包，锁内重读包/usage复验立即提交；bundled/user/pinned/archived不可改，锁外预检不穿越撤权/reset/重建。review不删/禁用/移动/执行shell；未来curator仅可恢复逻辑stale/archive，不永久删除。

扫描/锁/读写/发布固定nofollow fd，正文/支持文件单硬链普通文件。MCP每次list/call重读、短命stdio无跨Run连接，用户环境随workspace备份，不投影其它Agent/提示/消息/工作记录。交付、文档视觉基线及安装重定向由[集成](integrations.md#skill-学习边界)拥有。

## 备份与迁移

[布局备份集合](../reference/data-layout.md#备份与恢复)是一个恢复点，不能跨scope配workspace；[受控迁移](../reference/data-layout.md#受控迁移)独占来源资格、旧Skill保护、root例外、文件耐久/DB提交规则。缺失对象不授普通启动修复权限。
