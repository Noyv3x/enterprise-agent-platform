# 外部集成

配置入口见[配置参考](../reference/configuration.md)，wire 形状见 [Runtime API](../reference/runtime-api.md)。

## 能力与调用边界

| 能力 | 所有者 | 输入 → 输出 | 权限 | 失败 |
|---|---|---|---|---|
| OAuth | Platform／Runtime | 授权 → 模型／Token | 同代交集 | 拒绝回退 |
| 搜索／提取 | Platform／SearXNG／Firecrawl | query／URL → 搜索项／正文 | 公开 HTTP(S) | warning／error |
| 浏览器 | Platform／Camoufox | scope/tab → 页面／交互 | 内网信任、租约互斥 | degraded |
| Telegram | Platform Gateway | 私聊 ↔ 消息／投递 | 绑定用户 | 去重／复核 |
| 邮箱 | Platform | IMAP/SMTP ↔ mail／唤醒 | 私人主 Agent | checkpoint／幂等 |
| 计划 | Platform | 时间定义 → occurrence | 私人主 Agent | 原子暂停 |
| Skill | Platform | 工作区包 → 索引／正文 | 来源／生命周期 | 越权拒绝 |
| MCP | Runtime／Manager／Sandbox | stdio → 结果 | call 逐次审批 | 不 fallback |

Gateway 身份、owner、scope、lifecycle、来源消息只取可信 Run context，模型不能覆盖；MCP 不走 Python Gateway。root／delegate／scheduled／email／review 准入见 [Runtime](agent-runtime.md)。计划支持 once／interval／cron，不替代进程等待；无人值守 recurring Run 仅以空参数 `continue_current/complete_current` 决定本 occurrence，不能任意改计划，原子暂停见[数据设计](data-memory-sessions.md)。

## 发布与通用原则

Manager 独占固定服务 URL／启动／重试／重启，Platform 无安装／重启 API，只消费注入 URL 和实际健康探测；SQLite manage／URL／command／repo 不参与解析。开发同用外部 Compose/Manager，HTTP 替身不建第二生命周期。

[上游契约](../contracts/upstream-sources.json)锁定 URL/revision，CI 隔离验证构建，部署机只拉 digest、不留 checkout。无 Firecrawl gitlink／vendored tree／镜像副本，临时 checkout 不承载修改；适配属 Platform／Runtime／Manager，浏览器补丁属 `camofox-runtime/`，升级先改契约并验证镜像。Docker socket／bind mount／中性身份／镜像闭集见[部署](../operations/deployment.md)，迁移例外见[数据布局](../reference/data-layout.md)。

集成包描述、OCI/release 元数据、HTTP User-Agent 与审计前缀使用固定中性技术名称，不含源码维护方／部署方品牌，也不从管理员展示品牌派生。

失败只降级该能力，不损坏消息／任务／工作区；撤回不撤销已提交输入。更新预约阻止邮件、Telegram、计划、学习、恢复 Agent job；候选只读检查不解锁，匹配 operation 的 Gate 释放后才从 checkpoint 恢复。

## 模型 OAuth

Codex 设备码，Grok 浏览器授权后粘贴 callback URL；Platform 负责会话／state/PKCE／交换／刷新／导入导出／持久化。产品凭据只读 secret 行，OAuth／Telegram／邮箱凭据与浏览器 Cookie 不互代续期／过期。

- 同 provider 的 access token／refresh token／expiry／可选身份 token 完整验证后同一 SQLite 事务提交，刷新／导入／交互完成共用原子边界；失败留原组，不混写、不盲重试已消费授权码。
- 可执行集合只来自锁定 Pi 的 provider／API／endpoint／模型能力，可用集合只来自供应商账号，必须求交。当前凭据从未成功发现目录即不可用，仅同凭据最近成功目录可 stale；无硬编码 ID／退役表／版本／辅助优先级。视觉辅助按同 provider 输入能力枚举，以自己的 model ID 复验。
- 单调凭据 generation 绑定返回 Token 与放行目录，换号／刷新后重取一致快照；不拼旧 Token／新目录，不持有 auth lock 等待需该锁的目录 single-flight，Token 不进 session／metadata／事件。
- Codex 按 priority、Grok 按响应／alias 顺序，交集首项推荐，Runtime 不重排。自动／显式值见[配置](../reference/configuration.md#runtime-与模型)；OAuth 卡分别标推荐模型／可用数量。

Codex 草稿与 `prompt_cache_key` 见 [Runtime](agent-runtime.md)：不扩 OAuth scope／凭据／目录／连接，不增部署持久状态，不以缓存命中作为 readiness。

## SearXNG 搜索

直连受管 JSON `/search`，不经 Firecrawl；固定 general，可带语言／页码。预算内翻页，过滤重复／格式错误／本地／敏感参数 URL。输出标题／URL／描述／稳定位置，不自动抓正文；部分源失败保留结果＋warning。镜像、部署 UID/GID、完整只读配置挂载见[部署](../operations/deployment.md)。

## Firecrawl 提取

`web extract` 请求 `/v1/scrape` 的 markdown／HTML，优先 markdown，按预算裁剪。原始／最终 URL 均做公开 URL＋DNS SSRF 校验；带 Platform secret key 的请求拒绝重定向，key 不进 URL／Compose／journal。仅 PostgreSQL 队列，无 FoundationDB；服务集／镜像／HTTP readiness 见[部署](../operations/deployment.md)。

## Camoufox 浏览器

镜像含平台补丁、Playwright Core、锁定浏览器、Xvfb/headless，不读宿主 `DISPLAY`。`version.json` 记录真实锁定 release，不用资产名 `alpha.*`；server／camoufox-js 共用持久 cache。Profile／Cookie／下载／trace 按 scope 哈希隔离，模型不能指定 user id／profile／session key。

私有 API 可 `0.0.0.0`，pinning proxy 仅 loopback、不得复用 bind host。采用[安全设计](security-and-trust.md)的内网策略：字面地址／DNS／子资源同分类，mapped IPv6 先还原 IPv4，未指定／多播／保留／不可路由目标拒绝，普通 loopback／私网／ULA 不变；响应后取消仍终止上游流、释放 socket。

支持 tab／导航／snapshot／截图/vision／链接／图片／下载列表／提取／交互，console 无任意 JS。预览不启动／建 tab／导航／切 tab，无新增端口／WS／共享 X/VNC。人工租约与 Agent 变更按 root scope 互斥，冲突可重试、截图继续；身份／sequence／轨迹最终抬键见安全设计，JPEG／发送／退出见[前端](frontend.md#浏览器接管与发送)。Office/PDF／沙箱 HTML 是 Platform 本地派生，不是外部转换服务。

## 不可信内容

外部成功／错误文本均进防伪闭合 `untrusted_tool_result`，中和假标签、保留图片。长期指令双边界扫描／NFKC／Unicode／最小 secret 注入见[安全设计](security-and-trust.md)，不以扫描替代结构化边界或按关键词删普通网页。

## Skill 学习边界

Run 只见有界索引，正文／附件须显式 `load/read`。用户包在 `/workspace/.agent-platform/skills/<skill-id>/`；合法 `SKILL.md`＋支持目录通过路径／大小／frontmatter／注入／凭据校验后，首次扫描原子登记 `user-owned + active + enabled`，不因缺私有 sidecar 拒绝。每次读盘，索引下一 Run 重建，不半轮改已发送 schema／提示前缀。

预置层只读；复盘仅新建私有 Skill 或同次已读后精确 patch 自建、未置顶、active/enabled Skill，不删除／停用。非 Sandbox 可信来源、缺失旧状态按 user 失败关闭和提交时 lifecycle／账号／job／预算复验由[数据设计](data-memory-sessions.md#技能数据)定义，用户／预置／归档／停用 Skill 不得自动改写。

spreadsheet／document／presentation／PDF Skill 对明确交付意图主动用 Sandbox 固定库在 `/workspace` 产出原生文件、格式专属复验后 `MEDIA: /workspace/<relative-path>` 交付。成品可直接使用：按受众／用途统一字体层级、留白、对齐、克制配色，兼顾可读／可编辑／无障碍；检查截断／越界／拥挤表格／小字号／失真／装饰噪声，无品牌用中性专业主题、有模板遵循。表格默认 XLSX，除非明确其它格式或聊天小 Markdown 表；不临时联网装包、外部转换、在线 Office 或执行不可信文档。保留成品，只清理自己确认无用的中间文件，不删用户／上传／含义不明文件。Runtime 成功复验清除相关变更后保留 MEDIA，失败不恢复；Platform 按当前 scope 校验保存附件。

预置 Skill 保存脚本、计划或中间文件的示例必须使用工作区内固定的 `.agent-platform/`；不提供双路径回退，也不根据管理员品牌选择辅助路径。

## 工作区 MCP

无内置业务连接器。私人／频道主 Agent 独享 Skill 路径、`/workspace/.agent-platform/mcp.json`、`/workspace/.agent-platform/mcp/<server-id>/`；包／配置／凭据不共享，委派继承父配置。`.claude/skills`、`.claude/skill`、`.mcp.json`／HOME 安装只取可移植内容并重定向，不留影子配置。

清单仅 `mcpServers`，每项 `command`、可选字符串数组 `args`、字符串对象 `env`、工作区内 `cwd`。list/call 每次重读校验，无 watcher／reload／数据库副本。Manager 在当前 Sandbox 运行固定客户端，以 argv 启 server，`initialize → notifications/initialized → tools/list|tools/call` 后退出；仅接受 `2025-06-18`，其它版本在 initialized／调用前拒绝。

仅接受与请求 id 匹配的 JSON-RPC result/error；server 主动请求以 method-not-supported 回应，通知忽略。stderr、单行长度、消息数量、总输出与墙钟时限均有界，超限失败关闭。

缺配置为空；损坏／越界／命令或协议错误／超时／超限失败，无兼容搜索。config／cwd／工作区 command 打开后同 fd 验界、启动，不重解路径；普通文件非阻塞打开后验类型、及时拒 FIFO，大小限制覆盖实际读取。server 仅获声明环境和现有 Sandbox 权限。

call 逐次审批，普通参数完整展示、仅敏感字段值占位；隐形／双向字符或完整脱敏展示超限直接拒绝，不能截断后求批准。Runtime 事件及持久审计／快照／预览／工作记录仅 `action/server/tool`，可逆请求和原始 stdout/stderr 仅在执行闭包／Manager→Runtime 响应。描述／结果／错误以防伪不可信边界返回模型；凭据不得复制到其它 scope／提示词／日志，最小注入规则见[安全设计](security-and-trust.md)。

仅 stdio list/call；无 Streamable HTTP、OAuth、resources、prompts、sampling、elicitation、持久连接／后台 server／动态顶层工具。远程需用户装本地 stdio 适配器；Sylver Lining 等服务商维护包／API／origin／Token／动作，平台不锁定。

## Telegram

仅私聊，群组／超级群组／频道忽略。个人 AI 生成短时码，以 `/link CODE` 或 `/start CODE` 绑定。入站按 update id 去重，未确认重启可重领；offset 只确认连续成功前缀，批内失败停批，不能以较大 update 越过失败项和不可恢复原载荷。

出站持久 delivery job，已开始但结果未知为 `needs_review`、不盲重发；停用／轮换 bot 先吊销旧 sender generation 再停 transport。

## 邮箱

私人 AI 管理 IMAP/SMTP 应用密码、连接测试、立即检查／唤醒，不建邮件容器／完整客户端。系统 CA 验 IMAPS／SMTPS／STARTTLS，密码不进 Runtime／Sandbox／日志／工具结果。每用户最多二十账户，配额检查与新增同一写事务；频道／委派／他人不可访问。

mail 支持账户／文件夹／搜索／读取／发送／回复／移动／标记／保存附件。搜索先用 `UIDNEXT` 限最近有界 UID 窗口，不 `SEARCH ALL`；保留查询字符、转义反斜线／双引号，非 ASCII 显式 UTF-8 SEARCH。正文前取 `RFC822.SIZE`，缺失／超限拒绝；头部／正文／附件名不可信、不进工作记录 result。附件按[安全设计](security-and-trust.md) fd-rooted workspace 保存；删除仅移 Trash、不 expunge。投递持久幂等：确定成功完成，明确失败可新请求重试，未知 `needs_review`、不重发。

| 唤醒阶段 | 必须保持的边界 |
|---|---|
| 初始化 | `UIDVALIDITY + UID` checkpoint／去重；首次或 validity 变更用有效 `UIDNEXT` 建历史高水位，不扫描全邮箱，缺值拒绝。已初始化 `last_uid=0` 合法，不漏随后首信 |
| 增量 | 有界 UID 数值窗口＋更小批量上限；完整成功才进扫描边界，批满只到最后选中 UID，失败不越过 UID |
| 公平追赶 | 积压下一调度秒到期，持久到期时间严格前进、排其它到期账户之后，跨循环／重启保持公平 |
| 背压 | IMAP 前检查 queued/running 唤醒 job：账户 `4`、私人 scope `8`；满额不连／不读／不推进，按正常周期退避。同 scope 手工／后台共串行门、事务再核容量，释放后原 UID 续跑，不丢信／重复调用 |
| 预览 | 主题／发件人／收件人／抄送／日期／Message-ID 各≤`512` 字符，正文≤`4096`，附件仅数量；明确要求 `mail/read`＋可信 account/folder/uid 取全文 |
| 持久化 | 预览只存产品消息；job 仅类型＋`source_message_id`，调度／恢复／补偿从权威消息重建，不重复存正文。system trigger／job／checkpoint 同事务 |
| 更新 | 网络读取不占写准入；checkpoint／状态／触发落库前取短准入，预约已生效丢弃未提交结果，新 generation 原 checkpoint 重试 |
| unattended | email Run 仅读账户／目录／搜索／正文并汇报；其它工具、邮件副作用、附件保存、记忆修改、宿主命令均机械拒绝 |
