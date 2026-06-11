# 企业 Agent 平台

这是本工作区中 `hermes-agent` 和 `cognee` 本地仓库之上的企业平台层。平台负责默认的 Hermes 和 Cognee 运行时设置：准备 Hermes profile、安装并启用企业知识插件、启动 Hermes API server，并让 Cognee 使用平台托管的本地存储。

平台提供：

- 基于账号和密码的登录，并使用签名的 HttpOnly session。
- 基于频道的 Web 聊天。每个频道会路由到一个共享的 Hermes 主 Agent 线程。
- 按用户隔离的私人 Agent。平台会为用户创建独立工作区，并在 Docker 可用时启动托管容器。
- Codex OAuth 和 Grok OAuth 两种模型供应商验证。用户无需在私人 Agent 会话中输入模型密钥。
- 企业知识库，支持文档写入、搜索、每轮被动建议、可选 Cognee 混合索引，以及 Hermes 工具调用。
- 可在 Web 设置页管理 Hermes 和 Cognee 运行时。

## 运行

从空目录开始时，先拉取顶层仓库和 submodule：

```bash
git clone --recurse-submodules https://github.com/Noyv3x/enterprise-agent-platform.git
cd enterprise-agent-platform
```

如果已经拉取过仓库但没有初始化 submodule，可以执行：

```bash
git submodule update --init --recursive
```

然后从顶层仓库启动平台：

```bash
./deploy.sh
```

打开 `http://127.0.0.1:8765`。部署脚本会初始化 submodule、自动处理 Debian/Ubuntu 上缺失的 Python venv 依赖、清理残缺 `.venv`、创建根目录 `.venv`、带重试安装平台包、准备运行时状态，并启动应用。如果当前环境支持 user-level systemd，它会安装并启动 `enterprise-agent-platform.service`；否则会以前台模式运行。

如果系统没有 `python3.11-venv` 且脚本无法通过 `sudo apt-get` 自动安装，按错误提示手动执行：

```bash
sudo apt update && sudo apt install -y python3.11-venv
rm -rf .venv
./deploy.sh
```

首次运行前建议设置 `ENTERPRISE_ADMIN_PASSWORD`。如果未设置，平台会为引导账号 `admin` 生成随机初始密码，并写入数据目录下的 `bootstrap-admin-password.txt`（文件权限会尽量限制为 `0600`）。首次登录并修改密码后可以删除该文件；仅本地开发测试时可以显式设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1` 恢复 `admin` / `admin`。

通过 HTTPS 反向代理开放到公网时，把 `ENTERPRISE_PUBLIC_BASE_URL` 设置为公网地址，例如 `https://agent.example.com`。平台会据此为会话 Cookie 增加 `Secure` 属性，并校验浏览器写请求的 `Origin` / `Referer`。

登录后进入“设置”页面，在“API 供应商验证”中完成二选一的供应商授权：

- `Codex OAuth`：点击开始验证，打开页面并输入设备码，再回到平台点击检查状态。
- `Grok OAuth`：点击开始验证，打开授权页，浏览器跳转到本机回调地址后复制完整 URL 并粘贴回平台完成验证。

同一区域提供 OAuth 凭据导入/导出：管理员可以一键导出 Codex 与 Grok 的 OAuth token JSON 文件，并在新部署或重建环境后重新导入。

平台只保留这两个 Hermes 模型供应商；OpenAI、OpenRouter 或 xAI API key 不再作为模型供应商配置入口。

常用部署命令：

```bash
./deploy.sh update     # 拉取最新代码、同步 submodule，然后重新部署
./deploy.sh service      # 强制使用 user-level systemd 安装/启动
./deploy.sh foreground  # 强制以前台模式运行
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
```

## 托管 Hermes

无需单独安装或配置 Hermes。顶层部署脚本会初始化相邻的 `hermes-agent` 仓库；平台启动时会：

- 在 `data/runtimes/hermes` 下创建托管 Hermes home；
- 创建 `data/runtimes/hermes/venv`，并通过 `pip install -e` 从相邻的 `../hermes-agent` 源码安装 Hermes；
- 安装并启用 `enterprise-kb` 插件；
- 在尚未配置时生成 API server key；
- 使用托管 venv 以 `API_SERVER_ENABLED=true` 启动 Hermes gateway；
- 在设置页暴露安装、配置、状态和重启控制。

设置页可以更新 Hermes 源码路径、API URL、模型名、安装 extras、启动等待时间和 API server key。修改安装 extras 或源码路径后，下次托管 prepare/install 操作会刷新 venv。

平台会发送：

- `X-Hermes-Session-Id: enterprise-channel-<id>-main-agent` 用于共享频道 bot 线程。
- `X-Hermes-Session-Id: enterprise-private-u<user_id>` 用于私人 Agent。
- `X-Hermes-Session-Key` 用于长期记忆隔离。

只有在你明确希望自行运行外部 Hermes API server 时，才设置 `ENTERPRISE_MANAGE_HERMES=0`。

## 平台 Telegram Gateway

平台可以直接托管 Telegram Bot gateway。它不启用 Hermes 自带的 Telegram adapter，而是在平台层接收 Telegram private chat update，再统一路由到对应用户自己的私人 Agent。平台不会适配 Telegram 群组、超级群或频道；非私聊消息会被忽略。

推荐在页面配置：

- 管理员进入“管理面板 / Telegram”，配置启用状态、Bot Token、Bot 用户名、long polling 或 webhook secret。
- 每个用户进入“私人 Agent”，在 Telegram 私聊区域绑定自己的 Telegram ID。绑定后，该 Telegram 账号发给 bot 的私聊会进入自己的私人 Agent。

环境变量仍可作为首次启动或无页面配置时的兜底：

```bash
export ENTERPRISE_TELEGRAM_ENABLED=1
export ENTERPRISE_TELEGRAM_BOT_TOKEN='123456:telegram-bot-token'
export ENTERPRISE_TELEGRAM_BOT_USERNAME='your_bot_username'
export ENTERPRISE_TELEGRAM_POLLING=1
```

默认使用 long polling。若要用 webhook，在管理面板中关闭 long polling 并保存 webhook secret，然后在 Telegram 侧设置管理面板显示的 webhook URL。

用户可以向 bot 发送 `/start` 查看自己的 Telegram ID，再回平台绑定。

## Hermes 知识工具

平台会维护本地 SQLite/FTS 索引，以支持快速 UI 读取和确定性运行。设置 `ENTERPRISE_KB_BACKEND=hybrid`（默认）时，平台也会尝试通过本地 `cognee` 仓库进行写入/搜索；设置 `ENTERPRISE_KB_BACKEND=local` 可在开发时跳过 Cognee。Cognee 的数据、系统文件、缓存和日志默认位于 `data/runtimes/cognee`。

托管 Hermes 插件暴露以下工具：

- `enterprise_kb_search(query, limit)`
- `enterprise_kb_read(document_id)`

## 容器行为

默认值为 `ENTERPRISE_CONTAINER_BACKEND=auto`。如果 `docker info` 成功，平台会使用 Docker；否则会在 `data/workspaces/user-<id>` 下创建本地工作区。

常用设置：

```bash
export ENTERPRISE_CONTAINER_BACKEND=docker
export ENTERPRISE_CONTAINER_IMAGE=python:3.11-slim
```

## 前端开发

平台运行时仍从 `enterprise_agent_platform/static/` 服务静态文件；这些文件现在由 `frontend/` 下的 Vite + React + TypeScript 工程生成。当前业务界面逻辑保留为 `frontend/src/legacy-app.js`，由 React 入口启动，后续可以按页面逐步拆分为 React 组件。

安装和构建前端：

```bash
cd enterprise-agent-platform/frontend
npm install
npm run check
npm run build
```

本地开发服务器会把 `/api` 代理到默认平台后端 `http://127.0.0.1:8765`：

```bash
npm run dev
```

## 测试

```bash
cd ..
./deploy.sh test
```
