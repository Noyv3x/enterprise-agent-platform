# Frontend

React/TypeScript/Vite builds every surface from [Beautiful UI](https://www.beautifului.dev/), an MIT component library for AI interfaces, used as source rather than imitated (see [组件与视觉系统](#组件与视觉系统)). The [Platform API](../reference/platform-api.md) is the sole frontend wire contract; the browser does not call Runtime or Manager directly.

## Views

- Login and shell: Personal AI, Channels, Chat, Schedules, Admin and Settings in the sidebar. Keep neutral branding, theme and all three locales.
- Conversations: durable history, streaming text/thinking and tool activity, uploads, document previews and downloadable generated `MEDIA:` files. Thinking and tool calls stay visible after the reply finishes and after reload, from the persisted work trace (and, read-only, from older `agent_work` records). Sending during a run queues FIFO; there is no input joining or live file draft.
- Personal computer panel: browser screenshot preview, acquire/release human takeover and workspace file list/download. A held lease makes agent browser actions busy. Channels and chat have no browser panel.
- Chat: conversation list in the sidebar's chat section (search, create, rename, delete) and a model picker in the composer restricted to the user's allowed models. Each chat has a working directory in the user's shared lightweight sandbox; bash can access that user's other chat files.
- Schedules: create/edit/pause/resume/delete/run-now and occurrence history for personal AI. No continue/complete decision UI.
- Admin: users and permission groups, personal model/thinking settings, allowed/default chat model policy, branding, models/Codex OAuth, system/update controls and token usage including cache-hit ratio.
- Settings: kept account/preferences behavior with shared branding/theme/localization.

## State and behavior

Use Platform history and its stream contract, not Runtime transcript export, as the UI source. Display failed/interrupted work honestly and let the user resend; never silently replay it. Old messages remain readable, including old metadata, without restoring removed actions.

Remove memory/skills management panels, approvals, execution-review/needs-review controls, todo/delegation/background views, drafts, Telegram/mail and learning-review UI. AGENTS.md and SKILL.md are files managed with normal agent tools, not separate panels.

Server authorization remains authoritative even when controls are hidden. Preserve user input and reading position during streaming, navigation and locale/theme changes. Static assets ship with Platform: index is no-cache, hashed assets immutable, with available gzip/Brotli variants.

- Chat lists and model policy are scoped to the authenticated account. Logout/session expiry invalidates cached and in-flight results. Deleting a chat permanently deletes its working-directory files; confirmations state both consequences.
- Keep composer text and uploads when the first activity changes an empty conversation into a thread. Resend belongs to the originating stopped user request, not assistant completion order.
- Switches and timing segments change drafts only; saving requires the form's explicit submit action. Schedule actions serialize globally, and history refresh errors remain visible alongside cached runs.
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
  | 对话消息 | ThinkingState（思考与步骤）、ToolChips（工具调用）、StreamingText 与 StreamText（回答、流式光标、操作）、CodeBlock、LoadingState、ContextCards（附件） |
  | 输入框 | PromptBar（附件、斜杠命令、模型选择、发送与停止） |
  | 电脑面板 | AgentScreen |
  | 计划任务 | TaskRows、FilterTable |
  | 用户、权限组、频道 | RecordsTable、FilterTable |
  | 用量 | InsightCards |
  | 系统与更新 | TaskRows、StatusPill |
  | 品牌设置 | FineTuneCard |
  | 通用元素 | Button、Switch、SegmentedControl、Chip、EntityChip、ValuePill、StatusPill、ProgressRing、Shimmer |

- 上游没有的通用控件（单行与多行输入、下拉选择、对话框、侧拉面板、提示条、空状态）放在 `beautiful/controls/`，只用上游设计值和现有组件组合（GlideMenu 下拉、FineTuneCard 的字段样式、Button、SearchList 的空状态），外观与上游一致。不使用 Ant Design。
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
- 工作过程运行中只有标题文字的微光和步骤细环的旋转，不做多行持续动画。
- "减少动态效果"设置实时生效，不能因此刷新状态、丢失输入或关闭面板。

## Verification

Exercise the real browser surface for login, each conversation mode, attachments, model policy, browser takeover, schedules and administration. See [testing](../development/testing.md); mock screenshots or CSS assertions do not prove those behaviors.
