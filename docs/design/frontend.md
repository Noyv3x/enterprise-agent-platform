# Frontend

React/TypeScript/Vite keeps the existing Fieldwork and Beautiful UI design system. The [Platform API](../reference/platform-api.md) is the sole frontend wire contract; the browser does not call Runtime or Manager directly.

## Views

- Login and shell: Personal AI, Channels, Chat, Schedules, Admin and Settings. Keep neutral branding, theme and all three locales.
- Conversations: durable history, streaming text/thinking and tool activity, uploads, document previews and downloadable generated `MEDIA:` files. Sending during a run queues FIFO; there is no input joining or live file draft.
- Personal computer panel: browser screenshot preview, acquire/release human takeover and workspace file list/download. A held lease makes agent browser actions busy. Channels and chat have no browser panel.
- Chat: conversation list, create/rename/delete and model picker restricted to the user's allowed models. Each chat has a working directory in the user's shared lightweight sandbox; bash can access that user's other chat files.
- Schedules: create/edit/pause/resume/delete/run-now and occurrence history for personal AI. No continue/complete decision UI.
- Admin: users and permission groups, personal model/thinking settings, allowed/default chat model policy, branding, models/Codex OAuth, system/update controls and token usage including cache-hit ratio.
- Settings: kept account/preferences behavior with shared branding/theme/localization.

## State and behavior

Use Platform history and its stream contract, not Runtime transcript export, as the UI source. Display failed/interrupted work honestly and let the user resend; never silently replay it. Old messages remain readable, including old metadata, without restoring removed actions.

Remove memory/skills management panels, approvals, execution-review/needs-review controls, todo/delegation/background views, drafts, Telegram/mail and learning-review UI. AGENTS.md and SKILL.md are files managed with normal agent tools, not separate panels.

Server authorization remains authoritative even when controls are hidden. Preserve user input and reading position during streaming, navigation and locale/theme changes. Static assets ship with Platform: index is no-cache, hashed assets immutable, with available gzip/Brotli variants.

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

[Beautiful UI](https://www.beautifului.dev/)（MIT）是全站唯一的视觉语言。源码、改编说明和许可在 `frontend/src/components/ui/beautiful/`，许可文件随 `public/licenses/` 分发。

- 以下界面采用其源码的生产化改编：工作过程、等待状态、输入框、代码块、侧栏、分区标签、资源列表与状态标签、消息操作按钮和流式光标。
- 改编后的组件只接收真实状态、本地化文案和回调，不包含演示数据、定时脚本、远程图片或付费图标。
- 应用布局：侧栏在页面底色上，工作区是一块浮起的圆角面板；窄屏时工作区铺满。
- 管理页、设置和面板里的通用元素也使用 Beautiful UI 的样式：墨色主按钮、柔和底色的危险按钮、墨色开关、胶囊分段控件、安静的提示卡、居中的空状态、统计卡片。输入框和按钮分开放，不拼接在一起。
- 面板（抽屉）内的页面标题由面板标题代替，不重复显示。
- Beautiful UI 没有的交互控件（表单校验、选择器、弹窗、抽屉、表格、上传）继续用 Ant Design 提供行为，外观通过主题设计值对齐；不复制 Ant 内部结构，也不用高优先级样式硬覆盖。
- 共享组件不直接调用 API，也不自造数据。

### 排版、颜色与可访问性底线

- 字体：随静态资源分发 Inter 和 JetBrains Mono 的拉丁字符部分，不请求第三方字体；中文、中文标点和其它字符使用系统字体。等宽字体只用于代码、命令、时间和标识。
- 颜色：使用 Beautiful UI 的中性冷灰语义色，浅色、深色两套。主操作按钮和开关的开启态是墨色；品牌色用于发送按钮、链接、焦点和少量强调；导航选中态为中性灰。
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
