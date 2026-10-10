# Frontend

React/TypeScript/Vite builds every surface from [Beautiful UI](https://www.beautifului.dev/), an MIT component library for AI interfaces, used as source rather than imitated (see [组件与视觉系统](#组件与视觉系统)). The [Platform API](../reference/platform-api.md) is the sole frontend wire contract; the browser does not call Runtime or Manager directly.

## Views

- Login and shell: Personal AI, Channels, Chat, Admin and Settings in the sidebar. Keep neutral branding, theme and all three locales.
- Conversations: durable history, streaming text/thinking and tool activity, uploads, document previews and downloadable generated `MEDIA:` files. Thinking and tool calls stay visible after the reply finishes and after reload, from the persisted work trace (and, read-only, from older `agent_work` records). Each reasoning block renders the model's available reasoning summary (or raw reasoning text when exposed) as Markdown in secondary trace prose, with bold headlines and its own elapsed-time heading from the block's timestamps; older untimed blocks remain readable without a duration. Empty comment sentinels outside code fences and placeholder-only summaries are hidden. An open block without displayable text shows a quiet, politely announced thinking pulse in place; an empty finished block disappears. Streaming thinking text is not live-announced, and reduced motion stops the pulse. The overall thinking/work heading retains its elapsed time across inserted-message segments. Sending during an interactive run inserts into that run when eligible; pending inputs appear at the end of the live reply with an after-current-step label, then move to their delivery boundary between work segments, with a polite announcement. Persisted replies preserve those segments and channel authors; stopped inputs retain resend. Requests sit immediately before their linked replies, ordered by reply id, followed by the running turn and then truly queued messages. System and unpaired messages retain their id position. The composer explains insertion while working; there are no live file drafts.
- Manual context compaction shows as a status row at its place in the transcript (`after_message_id`), not pinned to the end; only an operation still queued, whose place is not known yet, follows the latest activity.
- Personal computer panel (Manus-style "the AI's computer"): no views to choose. One fixed-size window follows the AI step by step; below it the step description (the conversation's tool verbs) with its status (working, thinking, done, failed), a playback bar, the browser takeover action and a collapsed workspace file list/download. The window is AgentScreen's window mode (Beautiful UI's faux window: traffic lights, a title tab, an address row only for URLs and search queries) and renders the displayed step by kind: bash, grep, find and ls as a read-only terminal transcript of the run's shell steps up to that step (`$ command`, grep/find/ls as their equivalent commands, output scrolling live from `tool_output`, replaced by the final output at `tool_end`, failures marked); write, edit and read as the file with its path (content grows from `tool_input_delta`; edits as removed/added blocks, then the result diff); browser as the live screenshot with its tabs when it is the newest step of the current run or there is no step, otherwise a page card (url, action, output; screenshots are not kept); web_search as the query and readable results with links; web_fetch as the page's text; schedule, mcp and other tools as an argument summary and the result. Following shows the newest step of the live run (switching when a step begins), else of the run that just ended, else of the latest reply with tool steps (after reload). The playback bar (previous/next, a step scrubber, `n / total`, Live or Back to live/latest) reviews earlier steps; while reviewing, new steps and runs never move the window. Each personal AI tool row in the conversation has "View in computer", which opens the panel on that step. Window content follows the end while streaming unless the reader scrolled up; the expand control opens a larger viewer with the playback bar. Takeover (acquire/release; a held lease makes agent browser actions busy) pins the window to the live browser and pauses playback; handing back resumes following. Reloaded steps come from the bounded `metadata.work` and say when content was clipped. Very long content renders only part with a note; the terminal is `role=log` and only state changes are announced. The conversation's work trace does not show streaming input or output. Channels and chat have no computer panel.
- Personal AI subagents and background tasks (`bg-<n>`, see [product](product.md)): state comes from `GET /api/tasks` when the conversation loads plus SSE `task` events; a task that already ended never returns to running from an older snapshot. In the work trace a `task` row nests one row per subagent it started (matched by `created_by_tool_call_id`): name, a type badge (调研 for `scout`, 执行 for `task`), a status ring, the current activity, elapsed time and tokens; selecting a row opens the subagent sheet (its work trace, its report as Markdown, Stop with confirmation). A bash row that moved to the background (tool_end `details.background`, else its "Running in the background as bg-n" result) shows a `后台 · bg-n` chip with the task's live status that opens its output. `job`, `wait` and `task` rows read as 管理后台任务, 等待后台结果 and 分派子任务. A `task_notice` system message is a compact status row (「后台任务完成：bg-12 pytest · 退出码 0」, one line per task, each opening the task) before the AI's turn; notices marked `skipped` are hidden. The computer panel lists running tasks first, then recent ones, in 后台任务 above 工作区文件; a process opens a read-only terminal-style output viewer (AgentScreen's expanded-viewer frame) that long-polls `/api/tasks/{id}/output` only while open, from the retained tail, and says when earlier output was dropped; an agent opens its sheet. Stopping always asks first. Only task state changes are announced (politely), never activity or output.
- Chat: conversation list in the sidebar's chat section (search, create, rename, delete). The composer and header show no model; chat uses the account's model set by administrators. Each chat has a working directory in the user's shared lightweight sandbox; bash can access that user's other chat files.
- Admin: users and permission groups, personal model/thinking settings and an optional chat model per account (default: follow the personal AI), branding, models/Codex OAuth, system/update controls and token usage including cache-hit ratio.
- Settings: kept account/preferences behavior with shared branding/theme/localization.

## State and behavior

Use Platform history and its stream contract, not Runtime transcript export, as the UI source. Display failed/interrupted work honestly and let the user resend; never silently replay it. Old messages remain readable, including old metadata, without restoring removed actions.

Remove memory/skills management panels, approvals, execution-review/needs-review controls, todo views, drafts, Telegram/mail and learning-review UI. AGENTS.md and SKILL.md are files managed with normal agent tools, not separate panels. Subagents and background tasks exist for the personal AI only; channels and chat show none of their controls.

Server authorization remains authoritative even when controls are hidden. Preserve user input and reading position during streaming, navigation and locale/theme changes. Static assets ship with Platform: index is no-cache, hashed assets immutable, with available gzip/Brotli variants.

- Chat lists are scoped to the authenticated account. Logout/session expiry invalidates cached and in-flight results. Deleting a chat permanently deletes its working-directory files; confirmations state both consequences.
- Keep composer text and uploads when the first activity changes an empty conversation into a thread. Resend belongs to the originating stopped user request, not assistant completion order.
- Pasting (Ctrl/⌘+V) attaches the clipboard's files and images, read from its items with the file list as fallback; an unnamed clipboard image is uploaded as `pasted-image-N.<ext>`. In a conversation with a composer this works wherever focus is, except inside another text field or a dialog, and returns focus to the composer.
- Switches change drafts only; saving requires the form's explicit submit action.
- Browser tabs can be inspected without takeover. Expanded computer viewers sit above their parent sheet but below their popovers; Escape closes only the innermost layer.
- Malformed chat hashes follow the unavailable-route path. Disclosure IDs are unique per component instance, and every mobile sidebar selection dismisses navigation, including the current route.

## Branding

Use neutral defaults (`Agent Platform`, `Agent`), shared theme tokens and same-origin versioned logos. Branding changes affect display, not technical identifiers, paths or permissions. Do not load third-party fonts/images as fallbacks. Field validation and public branding shape belong to the [API](../reference/platform-api.md).

## 组件与视觉系统

### 设计原则

- 这是企业内部工作界面：不用宣传语、装饰性大标题或大片留白。
- 每页一个功能标题。说明文字只讲用法、权限、限制和真实状态。
- 同一种状态全站只有一种表达：
  - 细环表示正在进行；
  - 勾表示完成，警告标记表示失败；
  - 加载状态用像素网格动画加真实标签；
  - 分类标记（如"公共"）用图标，不用状态点。
- 权限、风险、引导、错误提示和危险操作确认不能为了简洁而删掉。保存按钮留在所属表单内。

### Beautiful UI

[Beautiful UI](https://www.beautifului.dev/)（MIT，源码 <https://github.com/slev12397/beautiful-ui>）是一个面向 AI 界面的前端组件资源库，也是全站的设计规则。界面直接使用它的源码，不再自制近似版本或另起一套设计层。源码、改编说明和许可在 `frontend/src/components/ui/beautiful/`（`NOTICE`），许可文件随 `public/licenses/` 分发。

- 来源：`foundation.css` 是上游 `app/globals.css` 的通用基础（设计值、浅色/深色、基础规则、间距工具、动画关键帧）；`atoms/` 是上游原子组件；`primitives/` 是上游组件，各组件的专属样式跟组件放在一起。
- 改编只允许：演示数据和定时脚本换成真实数据与回调；接入三种语言和无障碍；付费图标（Central Icons）换成开源图标；去掉远程图片、音效和营销内容。标记结构、类名、设计值、圆角（标签 6、控件 8、卡片 10、窗口 14）、细线边框、阴影和动效保持上游原样。
- 应用布局采用上游的 harness：底色（canvas）上是可收起的侧栏（SidebarNav），工作区是一块浮起的窗口（page 底色、窗口圆角、细线边框）；窄屏时侧栏变为抽屉，窗口铺满。
- 组件对应：

  | 界面 | Beautiful UI 组件 |
  | --- | --- |
  | 侧栏、对话列表与搜索 | SidebarNav、SearchList、GlideMenu |
  | 对话消息 | ThinkingState（思考与步骤）、ToolChips（工具调用；子智能体行嵌在 `task` 行下，后台 bash 行带 `后台 · bg-n` 标记）、StreamingText 与 StreamText（回答、流式光标、操作）、CodeBlock、LoadingState、ContextCards（附件）；后台任务通知用与上下文压缩相同的分隔线状态行 |
  | 输入框 | PromptBar（附件、斜杠命令、发送与停止） |
  | 电脑面板（单一窗口逐步跟随 AI） | AgentScreen（窗口模式：上游 FauxWindow 的窗口外框、标题标签与地址栏，按步骤类型渲染内容，展开查看器）、StatusPill、Button、StepScrubber（回放进度）、ToolChips 行操作（在电脑中查看）、CodeBlock 的等宽字体、分隔线与圆角；后台任务列表用 TaskRows（List），进程输出查看器用 AgentScreen 展开查看器的外框（ScreenViewer）加终端样式内容 |
  | 子智能体面板 | Sheet、ThinkingState 与 ToolChips（它的工作过程）、StatusPill、Markdown 报告、ConfirmDialog（停止） |
  | 用户、权限组、频道 | RecordsTable、FilterTable |
  | 用量 | InsightCards |
  | 系统与更新 | TaskRows、StatusPill |
  | 品牌设置 | FineTuneCard |
  | 通用元素 | Button、Switch、SegmentedControl、Chip、EntityChip、ValuePill、StatusPill、ProgressRing、Shimmer |

- 上游没有的通用控件（单行与多行输入、下拉选择、对话框、侧拉面板、提示条、空状态、步骤回放滑杆）放在 `beautiful/controls/`，只用上游设计值和现有组件组合（GlideMenu 下拉、FineTuneCard 的字段样式、Button、SearchList 的空状态），外观与上游一致。不使用 Ant Design。
- 品牌色写入上游的 accent 设计值（链接、焦点、发送按钮和少量强调），文字对比度自动保证；主按钮和开关的开启态仍是墨色。
- 共享组件不直接调用 API，也不自造数据。

### 排版、颜色与可访问性底线

- 字体：随静态资源分发 Inter 和 JetBrains Mono 的拉丁字符部分，不请求第三方字体；中文、中文标点和其它字符使用系统字体。等宽字体只用于代码、命令、时间和标识。
- 颜色：使用 Beautiful UI 的中性冷灰语义色，浅色、深色两套（`.dark`）。主操作按钮和开关的开启态是墨色；品牌色用于发送按钮、链接、焦点和少量强调；导航选中态为中性灰。
- 对比度：所有文字在其所在底色上至少 4.5:1，包括品牌色文字和状态色。状态不能只靠颜色区分。
- 触屏和窄屏上所有可点区域至少 44px。
- 系统开启高对比度（强制颜色）模式时，依靠阴影区分的表面要补上实线边框。
- 按钮文案按原样显示，不在中文字之间插入空格。

### 动效与阅读连续性

- 动效只用来说明位置和状态变化，不做装饰性入场、弹跳或主题渐变。切换主题时颜色直接切换。
- 内容在提交后变高时（展开工作过程、延迟排版、画中画留白），停在底部的读者继续跟随最新内容；正在往上翻的读者保持当前位置，也不增加未读数。
- 切换对话、加载更早的历史、流式输出都立即收敛，不制造额外的滚动动画。
- 工作过程运行中只有标题文字的微光、尚无可显示摘要的思考块的轻微脉冲和步骤细环的旋转，不做多行持续动画。
- "减少动态效果"设置实时生效，不能因此刷新状态、丢失输入或关闭面板。

## Verification

Exercise the real browser surface for login, each conversation mode, attachments, the administrator's chat model setting, browser takeover and administration. See [testing](../development/testing.md); mock screenshots or CSS assertions do not prove those behaviors.
