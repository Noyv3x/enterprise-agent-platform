# 企业 Agent 平台工作区

本仓库用于管理基于本地 Hermes Agent 和 Cognee 代码库构建的企业 Agent 平台。

## 目录结构

- `enterprise-agent-platform/`：平台 Web 层，包含账号登录、频道聊天、私人 Agent、宿主机工作区、Codex OAuth/Grok OAuth 供应商验证、企业知识库、测试，以及 Hermes 知识工具插件。
- `hermes-agent/`：指向 `NousResearch/hermes-agent` 的 Git submodule，用作 Agent 运行时和 OpenAI 兼容 API 后端。
- `cognee/`：指向 `topoteretes/cognee` 的 Git submodule，用作可选的企业知识图谱后端。

## 快速开始

先拉取仓库和 submodule：

```bash
git clone --recurse-submodules https://github.com/Noyv3x/enterprise-agent-platform.git
cd enterprise-agent-platform
```

如果已经拉取过仓库但没有初始化 submodule，可以执行：

```bash
git submodule update --init --recursive
```

然后启动平台：

```bash
./deploy.sh
```

然后打开 `http://127.0.0.1:8765`。部署脚本会初始化 submodule、自动处理 Debian/Ubuntu 上缺失的 Python venv 依赖、清理残缺 `.venv`、创建平台 `.venv`、带重试安装平台包、准备托管运行时状态，并启动平台。如果当前环境支持 user-level systemd，它会安装并启动 `enterprise-agent-platform.service`；否则会以前台模式运行服务。

如果系统没有 `python3.11-venv` 且脚本无法通过 `sudo apt-get` 自动安装，按错误提示手动执行：

```bash
sudo apt update && sudo apt install -y python3.11-venv
rm -rf .venv
./deploy.sh
```

首次启动前建议设置 `ENTERPRISE_ADMIN_PASSWORD`。如果未设置，平台会为引导账号 `admin` 生成随机初始密码，并写入数据目录下的 `bootstrap-admin-password.txt`（文件权限会尽量限制为 `0600`）。首次登录并修改密码后可以删除该文件；仅本地开发测试时可以显式设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1` 恢复 `admin` / `admin`。

通过 HTTPS 反向代理开放到公网时，把 `ENTERPRISE_PUBLIC_BASE_URL` 设置为公网地址，例如 `https://agent.example.com`。平台会据此为会话 Cookie 增加 `Secure` 属性，并校验浏览器写请求的 `Origin` / `Referer`。

登录后进入“设置”，在“API 供应商验证”中选择并完成 `Codex OAuth` 或 `Grok OAuth`。平台只保留这两个 Hermes 模型供应商；不再通过 OpenAI、OpenRouter 或 xAI API key 配置模型供应商。

首次启动时，平台需要相邻的 `hermes-agent/` submodule 存在。`./deploy.sh` 会自动初始化该 submodule；平台随后会创建 `enterprise-agent-platform/data/runtimes/hermes/venv`，从本地源码以 editable install 方式安装 Hermes，写入托管 Hermes 配置，并在 Agent 流量需要时启动 Hermes API server。Hermes 源码路径、API URL、模型名、安装 extras、启动等待时间和 API server key 都可以在平台设置页管理。

服务管理：

```bash
./deploy.sh update
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
./deploy.sh foreground
```

以后更新到最新版并重新部署，只需要：

```bash
cd enterprise-agent-platform
./deploy.sh update
```

`update` 会拉取当前分支的最新代码、同步 submodule，然后继续执行部署流程。

## 验证

```bash
./deploy.sh test
```

## Hermes 知识工具

托管启动流程会自动安装并启用 `enterprise-kb` Hermes 插件。该插件暴露以下工具：

- `enterprise_kb_search(query, limit)`
- `enterprise_kb_read(document_id)`

## 运行时数据

运行时数据库、独立 Agent 工作区、日志和密钥都不会提交到 Git。可以通过 `ENTERPRISE_PLATFORM_DATA` 指定平台数据目录。Agent 以可信内部成员模型在平台服务账号的宿主机环境执行，不创建每 Agent 容器；隔离边界是工作区、会话、记忆与浏览器 Profile，而不是恶意租户安全沙箱。
