# 企业 Agent 平台工作区

本仓库用于管理基于本地 Hermes Agent 和 Cognee 代码库构建的企业 Agent 平台。

## 目录结构

- `enterprise-agent-platform/`：平台 Web 层，包含账号登录、频道聊天、私人 Agent、托管工作区/容器、Codex OAuth/Grok OAuth 供应商验证、企业知识库、测试，以及 Hermes 知识工具插件。
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

如果首次启动前没有配置管理员密码，默认引导账号为 `admin` / `admin`。

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

运行时数据库、工作区、本地容器、日志和密钥都不会提交到 Git。可以通过 `ENTERPRISE_PLATFORM_DATA` 指定平台数据目录。
