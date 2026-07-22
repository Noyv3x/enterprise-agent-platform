# 部署

本文定义 ubitech agent 的受支持部署方式。配置见[配置参考](../reference/configuration.md)，自动更新见[自动更新](auto-update.md)，运行目录见[数据布局](../reference/data-layout.md)。

## 前置条件

- Python 3.11 或更高版本；
- Node.js 22.19 或更高版本及 npm；
- Git；
- 启用托管 SearXNG/Firecrawl 时需要支持 `docker compose up --wait` 的 Docker Compose；
- Linux 托管 Camoufox 需要部署脚本列出的图形和字体依赖。

部署优先使用兼容的系统 Node。缺失时，脚本可以下载 checksum 锁定的 Node 22.19.0 到平台数据目录，不修改全局 Node 或系统 PATH。自动包安装可以由运维配置关闭。

## 唯一部署入口

从仓库根运行：

```bash
./deploy.sh
```

首次部署执行以下工作：

1. 验证 canonical 文档、生成契约、最近提交与工作区的双向同步、Python、Node、仓库和目录；
2. 按上游源码契约把 Cognee 与 Firecrawl 的精确 revision 原子准备到平台数据目录；
3. 创建根 `.venv` 并安装 Python package；
4. 按 lockfile 构建并原子发布 Agent Runtime；
5. 准备 Camoufox、SearXNG、Firecrawl 和 Cognee 的受管状态；
6. 使用 user-level systemd，或在不可用时进入 foreground 模式；
7. 启动持久 Gateway，由 Gateway 启动动态回环 backend。

常用命令：

```bash
./deploy.sh service
./deploy.sh foreground
./deploy.sh prepare
./deploy.sh start
./deploy.sh stop
./deploy.sh restart
./deploy.sh status
./deploy.sh logs
./deploy.sh update
./deploy.sh test
```

`prepare` 只安装/发布依赖而不启动产品；`service` 强制使用 user systemd；`foreground` 是完整部署模式，不是绕过托管准备的开发快捷方式。

## systemd 与 Gateway

systemd unit 安装在用户配置目录，`ExecStart` 启动 `enterprise-agent-platform gateway`。unit 的 WorkingDirectory 指向平台 Python 项目，环境由部署时的环境变量和数据库持久设置共同生成。

服务使用 `Restart=on-failure`。要在注销后继续运行并随系统启动，需要启用 user linger；部署会尝试自动配置，失败时运维需执行 `loginctl enable-linger`。

Gateway 持有公共监听 socket，backend 只监听动态回环端口。重新部署时，已有 Gateway 接收 reload：先排空并停止旧 backend，必要时携带监听 fd 重新执行新 Gateway 代码，再启动新 backend。启动、停止和排空边界由部署实现及集成测试约束，不属于 Agent Runtime 跨层契约。

## 数据与首次登录

通过 `ENTERPRISE_PLATFORM_DATA` 选择状态根。首次启动应设置强 `ENTERPRISE_ADMIN_PASSWORD`；未设置时，随机初始密码写入 `$DATA/bootstrap-admin-password.txt` 并收紧权限。首次登录并修改密码后可删除该文件。

只有明确的本地开发环境可以启用默认弱密码开关。生产或公网部署不得使用它。

## HTTPS 反向代理

公网部署必须设置 `ENTERPRISE_PUBLIC_BASE_URL=https://...`，使 Cookie、webhook URL 和 Origin 校验使用真实地址。只有平台确实位于可信反向代理之后时才启用 `ENTERPRISE_TRUSTED_PROXY`；代理必须覆盖而不是转发客户端伪造的 `X-Forwarded-*`。

反向代理只公开 Gateway 的平台端口。Agent Runtime、SearXNG、Firecrawl 和 Camoufox 端口不得公开。

## 前端发布

部署脚本使用仓库中已经生成的静态资源，不在部署机重新构建前端。前端代码变化必须在提交前运行：

```bash
cd enterprise-agent-platform/frontend
npm ci
npm run check
npm test
npm run build
```

`npm run build` 验证并原子更新 `enterprise_agent_platform/static/`；源码和生成资源必须在同一提交中同步。

## 托管服务

平台默认管理 Agent Runtime、Camoufox、SearXNG 和 Firecrawl，并准备 Cognee。托管服务配置和日志都写入 `$DATA/runtimes`。SearXNG 与 Firecrawl 使用 Compose；Camoufox 和 Agent Runtime 使用平台启动的宿主机进程。

标准 `./deploy.sh service` 与当前管理界面使用平台托管的 Agent Runtime、SearXNG、Firecrawl 和 Camoufox，不提供切换外置 endpoint 的配置入口。适配器仍兼容外置服务：外置 SearXNG 只允许运维管理的本机数值回环服务；外置 Agent Runtime 和 Firecrawl 可以是受信任的 HTTP(S) 服务，但只支持通过 `./deploy.sh foreground`、直接启动或外部进程管理器提供相应环境配置。运维必须单独配置认证、限制网络访问，并保证 Runtime 所依赖的 workspace 与宿主路径语义成立；不得把无认证 endpoint 直接暴露到公网。Camoufox 没有外置运行模式，关闭其 managed 开关会关闭浏览器能力。

冷启动可能下载大型镜像和浏览器资产。管理界面中的 starting/prepared 状态不等于失败；等待边界由部署和托管服务配置及测试约束。

## 上游源码准备

本仓库没有 Git submodule。部署从 [`upstream-sources.json`](../contracts/upstream-sources.json) 读取固定 HTTPS 仓库地址、40 位 commit 和必需路径，在 `$DATA/runtimes/<name>/source/<revision>/` 下通过私有 staging checkout 准备；只接受实际 HEAD 与契约完全相等且必需路径有效的结果，再用同文件系统 rename 发布。并发部署由数据目录锁串行化，已验证的相同 revision 源码可离线复用，状态查询不联网。该离线承诺不包括 Cognee 首次 Python 依赖安装；在下次升级 Cognee revision 前，必须引入平台锁定的依赖集或按 revision 隔离的可回滚环境。

发布门禁必须在空数据目录中对两个契约 commit 执行真实浅拉取和同一套本地验证；只做 SHA 字符串校验或在源不存在时 skip 不构成发布验证。Firecrawl 还必须在无根目录 checkout 的 clean CI 中验证契约服务清单与全部 digest override 一致。

首次从旧 submodule 版本升级时，根目录可能残留 Git 已无法删除的旧 checkout。根路径被忽略以保持更新工作树 clean；部署只在确认旧 checkout 无本地修改且 HEAD 等于当前源码契约时，才可把它作为离线 Git object 来源。无论新受管源是否已经发布，平台都绝不自动删除、移动或改写根目录遗留 checkout；运维确认不再需要后才可手工清理。

源码准备、Cognee 依赖安装和生成的服务运行环境必须共用同一个有效 managed 开关。已有 `$DATA/platform.db` 中的 `cognee_manage` 或 `firecrawl_manage` 设置时，持久化值优先于对应的 `ENTERPRISE_MANAGE_COGNEE` 或 `ENTERPRISE_MANAGE_FIRECRAWL` 环境变量，与业务运行时的判定保持一致；只有数据库不存在或没有对应设置时才回退环境变量。首次部署在两处都无值时默认开启托管。有效开启时，生成环境必须把 managed 开关写为 `1` 并把 repo 固定为数据目录中的契约 revision，不得被遗留的外置环境变量绕过；有效关闭时，bootstrap 不得为它拉取固定源码或安装依赖，生成环境才保留运维提供的外置 repo 路径。

平台生成的 Firecrawl env/override 和 SearXNG 配置必须位于数据目录，使产品工作树在正常运行后保持干净。Cognee 的依赖在 prepare 阶段从固定 source 安装到平台受管 Python 环境；缺依赖必须使部署失败，不能延迟到摄取任务。业务进程只从该环境导入托管 Cognee，不直接导入或写入按 revision 发布的 source checkout，以保证同 revision 可在下次部署和回滚中继续通过干净性校验。

## 手工更新与回滚

`./deploy.sh update` 只在整个仓库没有 staged、unstaged 或 untracked 变化时工作。它获取仓库锁、记录当前 HEAD、执行 fast-forward，并在启动目标版本前验证其 canonical 文档、生成契约和本次代码/文档双向变化。目标版本未通过门禁时按部署失败处理并走同一回滚路径。上游 source 在 bootstrap 中按目标代码的契约另行准备，不参与产品仓库 fast-forward。

新版本部署失败时，脚本先再次确认没有并发产生的本地变化，再使用 `git reset --keep` 恢复旧 HEAD 并重新部署旧版本。按 revision 分目录保留的受管 source 允许旧版本复用其精确源；它绝不以 `reset --hard` 覆盖未知本地工作或清理未知遗留目录。

## 验证

部署完成后至少检查：

```bash
./deploy.sh status
curl -fsS http://127.0.0.1:8765/healthz
curl -fsS http://127.0.0.1:8765/healthz/search
```

如果使用反向代理，还要从外部验证登录、Secure Cookie、SSE、附件和维护页。完整测试命令见[测试与验证](../development/testing.md)。
