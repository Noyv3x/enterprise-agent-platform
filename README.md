# ubitech agent 工作区

本仓库包含 ubitech agent 平台、自研 Agent 运行时，以及可选的 Cognee 和 Firecrawl 后端。

## 目录结构

- `enterprise-agent-platform/`：Python Web 服务、React 界面、测试与部署代码。
- `enterprise-agent-platform/agent-runtime/`：基于 Pi Core 的平台自有 Node.js Agent 运行时，负责模型循环、工具、会话、记忆、审批与委派。
- `cognee/`：可选知识图谱后端的 Git submodule。
- `firecrawl/`：托管网页读取与抓取运行时的 Git submodule；网页搜索由平台独立管理的本地 SearXNG 服务提供。

## 快速开始

需要 Python 3.11+。部署脚本会优先使用已有的 Node.js 22.19+ 与 npm；缺少兼容版本时，会在数据目录中校验并安装锁定版本。默认启用的本地 SearXNG 以及托管 Firecrawl 需要较新的 Docker Compose（须支持 `docker compose up --wait`）。

```bash
git clone --recurse-submodules https://github.com/Noyv3x/enterprise-agent-platform.git
cd enterprise-agent-platform
./deploy.sh
```

如果仓库已拉取但 submodule 尚未初始化：

```bash
git submodule update --init --recursive
```

打开 `http://127.0.0.1:8765`。部署脚本会创建根目录 `.venv`、安装平台包、构建锁定依赖的 Agent 运行时、准备 Cognee/Firecrawl/SearXNG 状态，并通过 user-level systemd 或前台模式启动服务。

如果系统缺少 Python venv 支持且脚本无法自动安装：

```bash
sudo apt update && sudo apt install -y python3.11-venv
rm -rf .venv
./deploy.sh
```

首次启动前建议设置 `ENTERPRISE_ADMIN_PASSWORD`。未设置时，随机初始密码会写入数据目录下权限受限的 `bootstrap-admin-password.txt`。仅本地开发可显式设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1` 使用 `admin/admin`。

通过 HTTPS 反向代理开放服务时，请设置 `ENTERPRISE_PUBLIC_BASE_URL`。登录后可在设置页完成 `Codex OAuth` 或 `Grok OAuth`；平台不提供模型 API key 配置入口。

## 服务管理

```bash
./deploy.sh update
./deploy.sh service
./deploy.sh foreground
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
./deploy.sh test
```

`update` 只接受干净工作树上的 fast-forward 更新，并在重新部署失败时回滚到更新前的提交和 submodule 版本。

## 运行方式

Agent 由平台服务账号直接在宿主机执行，不创建每 Agent 容器。私人 Agent 与频道 Agent 分别拥有独立工作区、会话、记忆和浏览器 Profile；敏感操作仍通过 `once/session/always/deny` 审批。

运行时数据库、日志、OAuth 凭据、Agent 会话和工作区不会提交到 Git。通过 `ENTERPRISE_PLATFORM_DATA` 可更改状态目录，Agent 运行时默认保存于其中的 `runtimes/agent/`。
