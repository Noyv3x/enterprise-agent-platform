# 前端设计

本文定义浏览器行为、状态和可访问性；能力见[产品](product.md)，边界见[架构](system-architecture.md)，信任见[安全](security-and-trust.md)，持久状态见[数据](data-memory-sessions.md)，Runtime 协议见[API](../reference/runtime-api.md)。

## 技术与发布边界

| 范围 | 契约 |
| --- | --- |
| 构建 | 使用 React、TypeScript、Vite；视觉与可复制组件以 [Beautiful UI](https://www.beautifului.dev/) 为唯一基线，采用 MIT 源码并保留许可。基础交互可使用无样式的可访问性原语，不保留 Ant Design、Fieldwork 或第二套主题。frontend 为源，`enterprise_agent_platform/static/` 为不入 Git 的可重现产物；容器 frontend stage 的完整输出覆盖 wheel。同文件系统暂存、验证、压缩，先安装 hash 依赖，最后提交 identity/gzip/Brotli 入口；全部入口提交前保留旧依赖，之后删除清单外受管资产，不留旧 bundle 或跨 generation 兼容层。 |
| 加载/类型 | 未登录和恢复界面不静态引入聊天、电脑、浏览器或终端；bootstrap 确认用户后懒载 Shell，慢链路沿用启动反馈。组件、路由及 CSS 按需加载，不聚合未用模块。公开类型随当前 API 实体同改，不留旧 alias。 |

## 品牌与部署定制

未配置用 `Agent Platform`、`Agent`、纯文字、中性色及内置中性 favicon；登录、恢复、维护、错误、侧栏、metadata、通知共享可热更新品牌，绝不回退部署方硬编码值。Manager 离线页只承诺中性基线，无第二品牌库。管理员名称不翻译，周边说明三语化；通用 Logo 不作 favicon、不增加独立图标上传。

品牌字段、请求、revision 冲突、名称及 PNG/WebP 限制归[配置](../reference/configuration.md#品牌)，前端按同规则即时校验，服务端最终裁决。公开投影仅含名称、主色、同源版本化 Logo URL、revision 和 schema，不含其它设置或远程图片。Logo 保比例 contain、不反色，失败回退可访问文字；资产不进静态目录，旧固定 Logo 按陈旧资产清除。品牌与 locale 统一更新 document 语言、标题、description；技术 key、事件、通知 tag、下载名保持中性稳定，不派生自品牌。

公共品牌不随登录/Store reset 清空；首屏可恢复当前 origin 已验证缓存并并行重验证，无缓存用中性，网络失败保有效快照、不挡登录。

| 来源 | Context 与持久缓存提交规则 |
| --- | --- |
| 管理写 | revision 只进不退，同 revision 只接受完全相同内容；成功后缓存不带 ETag。失败（含 409）重读管理快照，同步表单 Store 与 Context。 |
| 公共 GET | 发起时捕获完整 Context 基线；返回时基线未变，合法 200 可接受服务端回滚后的低 revision，否则走单调栅栏。200 先完整验证结构、名称、颜色、同源版本 Logo；非法且基线未变时清除快照/ETag 并降为中性，迟到的非法响应不得清除新状态。 |
| ETag | 只缓存和发送精确的 `"branding-<revision>"`；缺失或不符不妨碍使用合法快照，但下次无条件 GET。304 仅复用请求携带匹配 ETag 的已验证缓存，否则按请求失败处理。 |
| 跨标签页 | 同 key 的连续 storage 事件去抖为无 ETag GET，永不直接应用 newValue，也不因旧值、冲突、删除或损坏值回写缓存。请求递增编号，只准最新在途请求提交，仍遵 GET 基线规则，支持回滚而不产生缓存 ping-pong。 |

## 组件与视觉系统

### 企业内部界面的设计原则

企业工作界面不用宣传语、装饰大标题或大片留白。每页一个功能标题，说明只讲用法、权限、限制和真实状态；空对话不重复页头。登录采用约 400px 单列表单，配品牌、帮助、语言和主题操作；恢复与维护使用普通字号。

Beautiful UI 的颜色、字体、层次、圆角、控件及聊天/工具/任务/审批呈现统一归本地源组件和主题维护；采用官方源的生产化改编，不只是给旧组件换皮。登录、设置、管理、预览、确认和维护页共用这一视觉语言。没有上游成品的表单、弹层和状态采用同一组设计值及无样式交互原语，不另建视觉体系。共享组合只接收本地化内容、真实状态、回调、插槽，不访问 API、复制 Store 或生成演示数据；不引入官网的假回复、模拟进度、付费图标或示例业务。Composer 的原生 textarea、mention option、隐藏文件 input 保留 IME、caret、焦点及会话附件状态机。

### 排版、密度与颜色

| 维度 | 基准 |
| --- | --- |
| 字体/密度 | 使用本地提供的 Inter 和系统中文无衬线回退，代码采用本地等宽字体，不在运行时请求第三方字体。正文/表单约 14px，对话保持适合长文的行高；Beautiful UI 的紧凑侧栏、8px 控件圆角、10px 卡片圆角、14px 窗口圆角及细边线/分层阴影构成基线。触屏目标至少 44px；不以官网演示尺寸牺牲中文、缩放和移动可用性。 |
| 颜色/信息 | 使用 Beautiful UI 的浅色和深色语义色，包括 page/canvas/surface、ink、line、accent 和状态色；品牌色通过同一语义层覆盖，不保留旧系统调色板。文字、边线、状态语义明确，状态不只靠颜色。品牌操作填充保持原值，强调文字在内容、选中、hover 底色上均达到 4.5:1，派生色与混合底色共用计算。保存留在所属表单，权限、风险、引导、错误和危险确认不能删减。 |

### 动效与阅读连续性

动效只解释位置和状态，无装饰入场、弹跳或主题渐变。电脑一次预留右侧宽度，仅新面板位移淡入；不动画列宽、flex-basis、输入或视口高度，不延迟卸载或租约释放。textarea 直接写入测得的有界高度。真实视口 resize 后，跟随者留底，阅读者保锚点且不增未读；stream、prepend、scope 切换即时收敛，不造消息或额外滚动动画。reduced-motion 实时作用组件、CSS 和文件呈现，不重挂 Store、丢输入或关面板；组件动效 Provider 常驻，不通过切换组件树实现偏好，也不另加动画系统。

## 应用外壳

| 范围 | 契约 |
| --- | --- |
| 层次 | i18n 在外层；Branding 在主题、维护门、错误边界、Store 外；UpdateGate 在登录、Store、Toast、业务错误边界外。错误边界可安全重载，Store 仅在正常生命周期创建。Shell 管理导航、内容、预览及移动遮罩；窄屏抽屉可关闭并恢复焦点，保留账号、语言、主题和权限操作。客户端路由不是授权边界。 |
| 认证 | 登录失败不区分账号是否存在；限流遵 Retry-After，倒计时不自动重发密码。bootstrap 一次取得用户、频道、scope、消息和 Agent 状态；默认个人 AI，仅服务端确认无权限才退首个可读频道。认证前、缓存恢复或失败回退不短暂选中频道或覆盖私人 scope。 |
| 用语/引导 | 用语为“公共频道 / Public channels / 公共頻道”和“个人 AI / Personal AI / 個人 AI”，内部身份不改。公共目的地和当前标题在窄屏也明示成员可见。个人引导挂在 Shell：history 就绪、无 loading/error、无消息或乐观行、Agent 空闲时，每次登录才自动展示一次；保留永久指南入口并走正式个人导航。“试试”仅在文字和附件均为空时填本地化示例并聚焦，不发送或覆盖草稿。 |

## 状态与数据访问

external store/useSyncExternalStore 的 selector 保稳定引用，常量/memo 派生默认值，不现场分配数组/对象/map/filter。按视图资源键惰性加载，不设重复聚合入口；Runtime 保存仅刷新 Runtime/OAuth，提及取 bootstrap，权限组取服务端。

| 边界 | 隔离/恢复 |
| --- | --- |
| 请求 | `api()` 统一携带同源 Cookie，401 使会话失效，维护响应触发 UpdateGate。换账号时取消旧请求，以 generation 拒绝迟到结果；scope 加载另有 scope/version fence。HTTP、SSE、轮询各有生命周期，不复用 Runtime 超时。 |
| 发送 | 读取或清空草稿、等待接管队列**前**捕获 generation、用户和 scope，等待后在创建 HTTP/XHR **前**复核。账号变化则丢弃旧 payload，不恢复进新 Store；仅同账号换 scope 时可放回原 scope 失败队列，且不覆盖新草稿。保留附件进度、失败恢复和连续发送。 |
| 上传 | XHR 沿用认证与维护语义，无固定墙钟超时；取消、登出、generation 变化、更新或配额可终止。真实字节进度达到 100% 后仍显示“处理中”，保存并入队才算提交；更新中断可重试。完成、错误、取消及 `send()` 抛错共用终止路径释放计数和监听；预先 aborted 的信号立即拒绝，不发请求。 |
| 审计 | 选择变化时同步隔离旧消息，仅当前选择的最新请求可写消息或清 loading；删除后的刷新不重新选回旧目标，标题、消息和删除对象始终同身份。 |
| 模型 | 仅使用 OAuth 安全交集，不复制 ID、排序或退役表；首项标推荐模型并显示数量，未授权或无成功目录时不展示 Runtime 候选。刷新不覆盖显式选择；Runtime 的 `""` 显示自动及当前推荐，修改其它字段仍保留空值；账号的系统默认先显示部署显式值，否则显示推荐。 |

聊天与通知均走正式异步导航 action。可变身份文字是不可信数据，前端长度校验不是提示词安全边界。

## 实时对话

| 行为 | 契约 |
| --- | --- |
| 历史 | scope SSE 为主，轮询仅作恢复；乐观行带本地身份，按稳定游标合并。首载最新页，`after_id` 独立前进，互斥的 `before_id` 分页去重 prepend。分页捕获 scope、before_id、prepend 版本、请求号及必填的 reset_revision；缺 revision 不 prepend。清空、隐藏、换 scope、新快照或同边界的新请求均撤销旧请求的提交及清 loading 权。prepend 保锚点、不增未读，不按 100 条裁掉历史。 |
| 恢复 | 返回缓存 scope 时先同步恢复消息、前向游标和分页，再用同游标 delta refresh，不以最新页覆盖旧页；仅未载入、缓存失效或 reset_revision 变化时重建全量边界。SSE CLOSED 且认证探测遇网络或服务端错误时，只要原 scope/generation 有效就有界退避；换 scope、卸载、维护或认证失效取消旧任务，不重复连接。 |
| 审批/撤回 | 审批携带所见的 run_id、approval_id、choice；身份过期返回 409 后刷新，不套用最新项，仅 approval_id 变化也须应用。MCP 共用脱敏逐次审批，不显示清单环境值。仅本人已持久化的频道用户消息可撤回；组件库确认并防重复提交，成功移除列表/缓存并随 reset_revision/SSE 收敛，失败保留并报错；撤回不取消 Run 或清理模型上下文。 |
| `/compact` | 输入 `/` 提供命令建议，当前仅注册无参数 `/compact`；保持 listbox/option、输入焦点及组件库按钮语义。对话空闲时由 Platform 请求 Runtime 压缩当前 session，并以本地化提示报告是否省略历史；不创建用户消息、乐观行、失败重发记录或 Agent Run，也不把命令文本作为聊天输入发送给模型。带附件、参数或存在排队/运行任务时保留草稿并拒绝；未知斜杠文本仍普通发送。 |

Markdown 支持 GFM、`$...$` 行内公式、独占行 `$$` 块公式及 `\$` 字面美元。KaTeX 排版与 MathML 随正文懒载，禁用可信命令；无效或流式未闭合公式保留源码/有界错误，不使消息树崩溃。原始 HTML、远端图片和不安全 URL 的边界不变。单源码换行安全显示，普通块折叠 AST 空白，代码保留原空白；各块采用紧凑一致间距，首尾不撑高，公式只在内部横滚。Agent 无气泡、用户有界气泡，与 Composer 同轴；私人 Agent 不显示作者名，频道保留展示名。用户副标题仅用非空职位或原有 `@username`，不以权限组或角色兜底；管理权限列独立。

**工作过程**仅由真实 `tool`、`tool.started`、`tool.completed` 建立；`learning.review.*` 不生成聊天、输入中状态、过程或通知。工具开始后过程固定在回复顶部，运行中（含最终输出开始流式显示后）保持紧凑可见，不提供折叠或详情控件；完成/失败后自动收起，键盘入口为“查看 AI 工作过程”。

- 时间线使用严格递增 sequence：阶段说明在结束边界追加一次并清除 finalized buffer；工具首次出现时占位，后续按 tool_call_id 原位更新，不按完成时间重排。最终正文不进入过程；旧 stream_messages 仅用于读取升级前状态，新实时正文只用 stream_message。
- 每行仅显示工具、单行摘要和状态，合并重复、匿名、内部噪声及审批。展开时间线后，仅有真实脱敏参数、结果、错误或阶段正文的项可展开。文件优先操作、唯一路径及正文/结果；terminal/process 优先完整脱敏命令和输出；搜索优先查询与命中；MCP 显示 server/tool，不显示环境值或已省略的外部结果；其它工具优先安全动作和结果。状态不重复，时间置末。
- parameters/result 遵[数据投影](data-memory-sessions.md)的闭世界、脱敏及正文排除规则。合法时间线完整保留，硬界触发时在原位/末尾显示截断及省略事件/字符数，不静默保尾。
- needs_review 显示最后真实有界说明、独立 blocker 和真实 agent_work，不使用成功样式或完成通知，不从其中的 MEDIA 文本提取附件。上下文详情仅显示最新已完成回复的占用，不混入供应商/Runtime 诊断。

**附件**唯一来源是 message.attachments，不解析正文或流式过程中的 MEDIA。卡片显示名称、类型、大小与下载；HTML 在聊天卡片中仅可下载，但可作为电脑呈现来源。XLSX/DOCX/PPTX/PDF 卡片右上固定展开和下载按钮，首屏有界，弹窗复用同一次预览响应；分别显示工作表、段落、分页幻灯文本及 PDF 已有文本层。历史与新附件同享预览入口；空/通用 MIME 的确定性映射归[安全设计](security-and-trust.md)。加载、空内容、截断和失败状态明确，预览失败不影响原文件下载。**预览渲染**只使用服务端文本，不解析公式或执行宏，不把 Office/PDF 原件交给浏览器解析器，也不引入另一套渲染库；这些限制不取消原文件下载。PPTX 按 presentation.xml 与内部 relationship 顺序显示，忽略未引用部件；缺失或不安全关系明确失败，不猜文件名顺序。格式校验与下载安全归[安全设计](security-and-trust.md)。

## 电脑画面

同 scope 只用一个 ChatPreviewContext、控制器与 Store 状态桥；scope、模式、展开、openComputer 和 capabilityActions 同源，页头只呈现同一插槽。记忆（私人）、技能（任意 scope）、任务（私人）保持独立；浏览器与终端共用至多一个电脑入口。电脑不是 OS、文件管理器、持久主页、回放或交互 PTY；不增加第二套实时屏/轮询，不新增 Runtime 工具或静态服务，也不因打开观察而创建资源。

精确三语只在此定义，个人/频道共用，不借导航工作区、Sandbox、宿主、Runtime或供应商词：

| 用途 | zh-CN | en | zh-TW |
| --- | --- | --- | --- |
| 区域标题 | AI 的电脑 | AI computer | AI 的電腦 |
| 卡片/页头/展开 tooltip与aria | 显示 AI 的电脑 | Show the AI computer | 顯示 AI 的電腦 |

### 画中画与展开

| 状态 | 契约 |
| --- | --- |
| 默认 | 阅读区右下、实际 Composer 上方放置 **16:9 浮动画中画**，与紧凑回底图标同处透明绝对定位层，**零文档流高度**，无整行白占位；空白部分穿透 pointer 和滚轮。未读数有界，按钮有清晰 tooltip/aria 且不重叠；短窗、长输入和缩放也不挤掉阅读区。 |
| 画面 | **真实屏幕铺满卡片**，无上下标题栏或状态白栏；名称、只读/工作状态、计时、展开标识使用小型半透明叠层，HTML 用大视口等比缩小。整卡可键盘展开；仅当前 Run 的 started_at 驱动计时，历史资源不续计。 |
| 展开 | **始终固定视口右侧 50vw、满可用高度，包括窄窗和所有缩放**，无全屏断点。聊天留在左侧，内部各自滚动；电脑是命名非模态 region，无居中弹窗、遮罩、全屏侧滑或焦点圈定。仅电脑区域内未被子控件消费的 Escape 可收起电脑，不拦截左侧 Composer 或其它非模态内容的 Escape；关闭后焦点回有效触发器，否则回 Composer。 |
| 生命周期 | 初入 scope 收起，推送不自动放大；明确展开保留到主动收起、离开 scope 或资源消失。resize 保持同实例，不重放手势或再取得租约。记忆、技能、任务互斥，打开时收起电脑并按队列释放接管。展开卸载画中画内容、轮询和 iframe，收起立即卸载展开内容，保持**单消费者**；浏览器展开时 browserDrawerOpen=true，openBrowserAssist 若仍存在，只用于明确接管。 |
| 显隐 | replying/approval 开始即显示等待工作画面，不虚构内容；仅排队不生成空屏。Run 结束后，仅活动浏览器、running/orphaned 终端或可读呈现页保留入口，否则隐藏。availability 加载不误判空闲，错误保留线索并可重试；仅服务端确认无资源且当前未工作时才隐藏。 |

### 屏幕模式

只显示 agent_status/工作行投影的最新可见电脑工具；同一 Run 切换同一屏幕，不开多窗，不解析 journal、正文 MEDIA 或猜测宿主路径。

| 模式 | 内容/限制 |
| --- | --- |
| 文件 | read_file/write_file/patch_file 的**画面只读**；`GET /api/agent-previews/file` 以投影的 workspace_path 读取当前工作区相对路径，返回有界 UTF-8 和截断标记。host 目标仅显示脱敏路径/状态，不请求正文。 |
| 终端 | 按当前 Run 和仍活动的 orphaned 进程分组；orphaned 显示“需关注、仍占用”，不能算完成或隐藏。深色 SSH 式画布先显示 `$` 与完整脱敏命令，再显示真实有界输出，用户未主动上滚时跟随末尾。短命令早于预览完成时，用对应最新工作行 result 补输出与终态，不能退为参数表；不提供输入或 ANSI/curses 仿真。 |
| 浏览器/搜索 | browser 仅在已有 tab 或浏览器工具进行中时可用；无资源则转其它存活模式或隐藏，协助可先显示骨架，帧未到不等于资源不存在。web/search_files 只投影有界标题、URL/相对路径、摘要并按纯文本渲染，不变成文件浏览器。 |
| 呈现 | 来源为当前工作区成功写出的 .html/.htm，或本 scope 最新成功回复的 HTML 附件/投影 MEDIA 路径；src 仅用认证 `GET /api/agent-previews/present`。写入仍 running 且无 present_available 时先显示骨架，不先挂会返回 404 的 iframe；同路径写完成后以生命周期/可用性 revision 刷新。页面应自包含，不是 Camoufox；iframe 带 sandbox 且无 allow-same-origin，脚本只能在不透明源运行，不能访问父 DOM、Cookie 或产品 API，也不能以 innerHTML 执行呈现页。 |

**草稿**仅 Codex OAuth Responses 参数增量可产生 source=draft：write 为完整草稿，patch 明确标为替换片段，均显示“未提交”，不代表保存、审批或执行。聊天 SSE 仅带单调 revision、不带草稿正文，真实字符来自授权 endpoint；非持久生命周期见[数据](data-memory-sessions.md)。

- revision 领先正文时保持单在途并追最新版本，不反复 abort；同一草稿已读到的高版本可先显示，不因后续排队全部丢弃。scope、Run、tool call、路径、target 或终态变化使旧响应失效，不覆盖新版本或正式快照。
- write started 到原子落盘间的 404 是等待态，进行有界重试；完成/失败清草稿并改变 revision，成功后读取**同路径最终快照**，patch 不能停留在旧正文。
- 仅对已取得的真实字符做有界连续追赶、变更高亮和活动光标，不造字符或在同一封顶延迟整块出现；超过逐行 DOM 预算改单文本画布。其它模型只动画真实快照。reduced-motion 共用实时订阅，立即显示权威版本，无需重载。

### 浏览器接管与发送

默认只读；文件、终端、搜索和呈现不接受远端控制输入。查看不启动浏览器、创建 tab、导航或切换 tab。已有授权 viewport 经同鉴权 HTTP 两秒级低频 JPEG 观察；接管时按服务端间隔有界提频，静止退避，退出/失焦回低频，隐藏不取图。ETag、CSS 像素截图和低质量压缩避免重复正文及坐标漂移。

| 转换 | 状态动作 |
| --- | --- |
| 取得 | 必须明确手势；先可观察地显示服务端已确认租约，短租约也不能被渲染竞态吞掉，再按服务端租期到期。租约绑定取得时的 tab_id，不随轮询改绑。acquire/input/release 共一串行队列，sequence 按序发送，不使用并发 fire-and-forget。 |
| 拖拽 | 使用 Pointer Events，down 后取得 capture；本地合并有界、单调时间轨迹，up 以单个 sequence 提交 down→move[]→up，并显示本地指针反馈。鼠标、触屏、笔共用左键语义，不支持多点缩放、文件选择、剪贴板或任意导航。 |
| 退出 | 结束、pointercancel、capture 丢失、失焦、隐藏、tab 变化/关闭、到期、卸载或租约冲突时，立即只读、清未提交轨迹，并尽力 release 原 tab/lease。已开始执行的完整轨迹由服务端 finally 抬键，不另设伪中断协议。 |
| 发送 | 同 scope 先同步只读，等待在途 acquire、input 和对应 release 全部收敛；不重复 payload、不挡下一条草稿，等待前后复验[账号、用户和 scope](#状态与数据访问)。服务端入队租约隔离归[安全](security-and-trust.md)。 |

## 通知与账户集成

| 功能 | 契约 |
| --- | --- |
| 通知 | 显式开启，由手势请求权限；页面已加载、权限 granted 且隐藏/失焦时，对所有可访问 scope 的新持久成功回复各通知一次。独立完成 SSE 含单调持久消息 ID、scope 类型/ID；初连建水位，重连用 Last-Event-ID。hydrate、历史、重复事件、切 scope 首载或可见页面不通知；离开聊天或隐藏时仍接收全部 scope。点击聚焦并走正式导航，目标就绪前不显示旧消息。不是 Web Push：重载重建水位，不补关闭期；非 secure context 明示不可用。 |
| 安全/邮箱 | LAN 默认关闭，可设独立地址、直连和可信入口 CIDR；仅展示 Platform 实际绑定，不改容器 host/port。TTL 取服务端值，未返回才用安全设计出厂值，并说明 Cookie 保存和服务端活动续期；明文 LAN 明示 Cookie、同源和通知风险，“已保存”不等于 TLS。私人邮箱提供账户、凭据状态、测试、立即检查和收信唤醒；密码不回填，修改其它字段不清密码，文案三语齐全。 |
| 扩展/频道 | 不提供服务商专用卡、Sylver 入口、第二份 MCP 表单或连接 Store；Skill/MCP 经对话写标准工作区，保留 Skills 管理。频道提示 trim、转小写、空格转连字符后为 2–49 ASCII：首字符为字母/数字，其余可含字母、数字、`_ . -`；仍提交原输入，由服务端规范化。 |

管理员和经理在频道导航中可删除公共频道。确认框显示真实频道名称，并说明删除将停止频道工作、取消成员访问，但保留历史与文件且不提供恢复入口。请求期间防重复；失败保留可重试入口并真实报告清理状态。删除当前频道后，立即撤销其缓存、草稿、异步读取和电脑接管投影，走正式导航切换个人 AI、其它可读频道或无频道空态；其它成员刷新或发现访问失效时同样收敛，迟到响应不能恢复已删除频道。

## 响应式布局

动态视口与安全区约束根布局；聊天独立滚动，底部输入有界增长，不遮挡消息尾部，浮动操作避开输入与安全区。URL、代码、表格和 pre 在内部滚动或安全换行，不撑宽根。除[固定右半电脑](#画中画与展开)，侧栏不能挤破可读宽度；记忆、技能、任务、Telegram、电脑同属页头操作组，窄屏换行不截断。

管理/设置用页内索引，不增第二固定导航；窄屏表单单列、操作换行，宽表只在内部滚动。账号行展示真实身份、状态、权限和模型，创建/编辑使用抽屉；审计将选中目标消息与危险操作分区，用量展示真实汇总及按日、账号、scope、模型的表格。不把旧行高、宽度或列数当成契约。

底层服务是只读健康视图，不是生命周期控制器。仅显示 name、available、state、detail、error 及缓存新鲜度，不暴露内部 URL、路径、管理来源或 managed 字段。状态仅 running、unavailable、available、missing、error、invalid_config，不保留旧安装、准备、外部运行或停止文案。

## i18n 与可访问性

| 项目 | 契约 |
| --- | --- |
| 语言/主题 | 支持 zh-CN、en、zh-TW，默认浏览器语言并存 eap-locale；新增 UI 文案三语齐全，组件 locale 同步，不翻译用户、Agent、工具、文件或日志内容。React 前应用主题防闪；品牌、深浅主题、触屏、长文和 reduced-motion 同时可用。 |
| 焦点 | 无样式可访问性原语或浏览器原生机制管理 Dialog/Drawer 的焦点圈定、Escape、嵌套及恢复，不用 document-capture 提前关闭父层。Select 先消费 Escape，嵌套确认只关闭顶层，保留底层编辑器和未存输入；返回有效触发器或所属界面合理目标。电脑为非模态例外；图标有可读名称，键盘焦点清晰。 |

## 容器管理状态

| 范围 | 契约 |
| --- | --- |
| 状态/身份 | 展示当前/候选/上一 generation、commit、activated_at、健康、下载、state、phase 和安全错误；回滚沿用原启用时间。数值 generation 透传 expected_generation，不能用 release current/target/previous.id 替代；Platform 规范 RFC3339 checked_at 和 service status，未知或不可用状态不显示 ready，公开探针只用 state，不拿 phase 替代。 |
| 目录 | 逐项显示 platform、agent-runtime、camofox、searxng、firecrawl-playwright、firecrawl-redis、firecrawl-rabbitmq、firecrawl-postgres、firecrawl-api；Manager 可并列。不能合并必需依赖，也不保留 FoundationDB。 |
| 操作 | 检查可刷新候选，但不创建 operation、安装或切换；更新、重启、回滚走 operation，不拼 Docker/Git 命令。预拉取和 waiting_for_tasks 不挡其它页，updating 由全局 UpdateGate 接管。readiness 失败保旧 generation 和有界错误，不泄露路径、marker、迁移细节或绕过维护门；Platform 可用时显示 operation id 及宿主 CLI 恢复提示，不泄露 socket、registry 凭据或完整日志。Manager 不可达时不伪造 idle，明示控制面不可用，并禁用配置保存、检查、更新、重启、回滚全部写入口；无回退控制器。 |

## 验证

命令与真实浏览器矩阵唯一归[测试与验证](../development/testing.md#前端)，不以源码/CSS 形状或伪造数据代替交互证据。
