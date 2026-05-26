# 企业 Agent 平台

这是本工作区中 `hermes-agent` 和 `cognee` 本地仓库之上的企业平台层。平台负责默认的 Hermes 和 Cognee 运行时设置：准备 Hermes profile、安装并启用企业知识插件、启动 Hermes API server，并让 Cognee 使用平台托管的本地存储。

平台提供：

- 基于账号和密码的登录，并使用签名的 HttpOnly session。
- 基于频道的 Web 聊天。每个频道会路由到一个共享的 Hermes 主 Agent 线程。
- 按用户隔离的私人 Agent。平台会为用户创建独立工作区，并在 Docker 可用时启动托管容器。
- 集中的模型/API key 配置。用户无需在私人 Agent 会话中输入模型密钥。
- 企业知识库，支持文档写入、搜索、每轮被动建议、可选 Cognee 混合索引，以及 Hermes 工具调用。
- 可在 Web 设置页管理 Hermes 和 Cognee 运行时。

## 运行

```bash
cd ..
./deploy.sh
```

打开 `http://127.0.0.1:8765`。部署脚本会初始化 submodule、创建根目录 `.venv`、安装平台包、准备运行时状态，并启动应用。如果当前环境支持 user-level systemd，它会安装并启动 `enterprise-agent-platform.service`；否则会以前台模式运行。

如果首次运行前未设置 `ENTERPRISE_ADMIN_PASSWORD`，默认引导账号为 `admin` / `admin`。

常用部署命令：

```bash
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

## 测试

```bash
cd ..
./deploy.sh test
```
