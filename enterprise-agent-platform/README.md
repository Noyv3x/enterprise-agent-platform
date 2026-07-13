# ubitech agent

ubitech agent 提供账号登录、频道与私人 Agent、Codex/Grok OAuth、知识库、Telegram Gateway，以及平台自有的 Agent 运行时。

每个私人 Agent 和频道 Agent 都有独立工作区、会话、记忆和浏览器 Profile。Agent 由可信的平台服务账号在宿主机执行；敏感操作仍需要运行审批。

## 运行

需要 Python 3.11+、Node.js 22.19+ 和 npm。若启用托管 Firecrawl，还需要 Docker Compose。

从顶层仓库执行：

```bash
git clone --recurse-submodules https://github.com/Noyv3x/enterprise-agent-platform.git
cd enterprise-agent-platform
./deploy.sh
```

打开 `http://127.0.0.1:8765`。部署脚本会初始化 Cognee 和 Firecrawl submodule、创建根目录 `.venv`、安装 Python 平台、按 lockfile 构建 Node.js Agent 运行时，并启动服务。支持 user-level systemd 时会安装 `enterprise-agent-platform.service`，否则以前台模式运行。

如果系统缺少 Python venv 支持且无法自动安装：

```bash
sudo apt update && sudo apt install -y python3.11-venv
rm -rf .venv
./deploy.sh
```

首次运行前建议设置 `ENTERPRISE_ADMIN_PASSWORD`。未设置时会生成随机初始密码并写入数据目录下权限受限的 `bootstrap-admin-password.txt`。首次登录并修改密码后可以删除该文件；仅本地开发可显式设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1` 使用 `admin/admin`。

通过 HTTPS 反向代理开放服务时，请把 `ENTERPRISE_PUBLIC_BASE_URL` 设置为公网地址。平台会为会话 Cookie 启用 `Secure` 并校验浏览器写请求的 `Origin` / `Referer`。

常用命令：

```bash
./deploy.sh update
./deploy.sh service
./deploy.sh foreground
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
./deploy.sh test
```

## 模型授权

在“设置 / API 供应商验证”中完成一种授权：

- `Codex OAuth`：启动设备码流程，完成授权后检查状态。
- `Grok OAuth`：打开授权页，将本机回调后的完整 URL 粘贴回平台。

管理员可以导入或导出两种 OAuth 凭据。Python 平台负责凭据刷新和持久化，Agent 运行时只获取当前调用所需的短期访问凭据。平台不提供 OpenAI、OpenRouter 或 xAI API key 配置入口。

## Agent 运行时

`agent-runtime/` 是平台自有的常驻 Node.js sidecar，直接使用精确锁定的 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。它负责：

- 流式模型与工具循环；
- 追加式 JSONL 会话和上下文压缩；
- 工具审批、取消和宿主机进程组清理；
- 文件、终端、记忆、知识、网页、浏览器与委派工具；
- Python 平台使用的私有 HTTP/SSE 协议。

托管运行时构建到 `$ENTERPRISE_PLATFORM_DATA/runtimes/agent/app`，状态保存在 `$ENTERPRISE_PLATFORM_DATA/runtimes/agent/`。默认只监听 `127.0.0.1:8766`，并使用平台管理的 bearer token；不要把该端口直接暴露到公网。

可通过以下环境变量覆盖初始设置：

```bash
export ENTERPRISE_MANAGE_AGENT_RUNTIME=1
export ENTERPRISE_AGENT_RUNTIME_URL='http://127.0.0.1:8766'
export ENTERPRISE_AGENT_RUNTIME_HOME='/path/to/data/runtimes/agent'
export ENTERPRISE_AGENT_RUNTIME_PROVIDER='openai-codex'
export ENTERPRISE_AGENT_RUNTIME_MODEL='gpt-5.5'
```

运行时源码的独立检查：

```bash
cd agent-runtime
npm ci
npm run check
npm test
npm run build
```

## 知识与网页工具

平台维护 SQLite/FTS 知识索引。`ENTERPRISE_KB_BACKEND=hybrid`（默认）会同时使用本地 Cognee submodule；`ENTERPRISE_KB_BACKEND=local` 仅使用本地索引。Cognee 状态默认位于 `data/runtimes/cognee`。

Agent 通过平台内部接口调用知识搜索和文档读取；网页搜索、提取与抓取通过托管 Firecrawl，浏览器操作通过按 scope 隔离的 Camofox Profile。生成文件只允许从工作区和明确配置的媒体根目录回传。

## Telegram Gateway

平台只处理 Telegram 私聊，不接收群组、超级群或频道消息。管理员在“管理面板 / Telegram”配置 Bot Token、用户名和 long polling/webhook；用户在私人 Agent 页面生成短时绑定码，再向 Bot 发送 `/link CODE` 或 `/start CODE` 完成绑定。

环境变量可用于首次启动：

```bash
export ENTERPRISE_TELEGRAM_ENABLED=1
export ENTERPRISE_TELEGRAM_BOT_TOKEN='123456:telegram-bot-token'
export ENTERPRISE_TELEGRAM_BOT_USERNAME='your_bot_username'
export ENTERPRISE_TELEGRAM_POLLING=1
```

## 自动更新

管理员可通过 GitHub webhook 和轮询监听目标分支。自动更新只在工作树干净且远端可 fast-forward 时运行，并复用 `./deploy.sh update` 的 submodule 同步、重新部署和失败回滚路径。

```bash
export ENTERPRISE_AUTO_UPDATE_ENABLED=1
export ENTERPRISE_AUTO_UPDATE_INTERVAL_SECONDS=30
export ENTERPRISE_AUTO_UPDATE_REMOTE=origin
export ENTERPRISE_AUTO_UPDATE_BRANCH=main
export ENTERPRISE_AUTO_UPDATE_WEBHOOK_SECRET='change-this-secret'
```

## 宿主机执行边界

私人 Agent 工作区为 `data/workspaces/user-<id>`，频道 Agent 工作区为 `data/workspaces/channels/channel-<id>`。子 Agent 共享父 Agent 工作区，但使用独立会话、记忆与浏览器状态。

这是面向可信成员的逻辑隔离，不是恶意租户安全沙箱。同一服务账号执行的命令可能访问该账号可读写的其他数据；所有宿主机命令和文件修改均需选择 `once/session/always/deny`。受保护路径的直接文件写入会被拒绝，明显的关机、磁盘格式化、删除系统根、fork bomb 和云元数据命令另有文本规则拦截，但这些规则不能替代最小权限、网络隔离或 cgroup/systemd scope。

## 前端开发

React + TypeScript 源码位于 `frontend/`，构建结果发布到 `enterprise_agent_platform/static/`；不要直接编辑生成资源。

```bash
cd frontend
npm ci
npm run check
npm test
npm run build
npm run dev
```

开发服务器将 `/api` 代理到 `http://127.0.0.1:8765`。界面 i18n 支持简体中文、English 和繁體中文，范围仅限浏览器界面。

## 验证

从顶层仓库运行：

```bash
./deploy.sh test
```

该命令运行 Python 单元测试与编译检查，并执行 Agent 运行时的依赖安装、类型检查、测试和构建。前端检查由 CI 单独执行。
