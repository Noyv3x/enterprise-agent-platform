# 项目内安全检查

日期：2026-07-13

## 范围与信任边界

本次检查覆盖：

- `enterprise-agent-platform/enterprise_agent_platform/`
- `enterprise-agent-platform/agent-runtime/`
- `enterprise-agent-platform/frontend/` 与生成静态资源
- 顶层部署、自动更新和回滚路径

Cognee、Firecrawl 上游 submodule、反向代理、TLS、DNS、防火墙、Docker daemon 与宿主机基线不在本次代码审查范围内。

平台按可信成员、小规模内部使用设计。Agent 由平台服务账号直接在宿主机执行；工作区、会话、记忆和浏览器 Profile 提供逻辑隔离，但不构成针对恶意租户的操作系统安全边界。部署方必须把 Agent 可访问的宿主机权限控制在可接受范围内。

## 已有控制

### 登录与浏览器入口

- 未设置 `ENTERPRISE_ADMIN_PASSWORD` 时生成随机初始密码，并写入权限受限的 `bootstrap-admin-password.txt`；默认不开放 `admin/admin`。
- 密码有最低长度要求，登录失败按账号和客户端限流；改密、权限变化、停用和吊销会使既有 session 失效。
- Cookie 使用 `HttpOnly`、`SameSite=Lax`，公网基准 URL 为 HTTPS 时增加 `Secure`。
- Cookie 写请求校验 `Origin` / `Referer`，仅显式可信代理模式读取转发头。
- 响应包含 CSP、拒绝 iframe、MIME sniffing 防护和 referrer 限制；500 响应不向客户端返回 traceback。
- SVG、HTML、文本、PDF 与 Office 等上传内容强制下载，只有受支持的位图格式可内联展示。

### Agent 运行时

- 托管 sidecar 默认仅监听 `127.0.0.1:8766`。所有端点（包括健康检查）均使用定时安全比较的 bearer token。
- 运行时 token 由平台生成并保存为 secret；OAuth refresh token 只保存在平台数据库，不写入 Node.js 运行时目录。
- HTTP 请求体有大小上限，SSE 与 JSON 响应禁用缓存，运行时目录以受限权限创建。
- 文件工具先解析真实路径；工作区内读取可直接执行，文件修改及工作区外访问进入审批。搜索遍历跳过软链、`.git` 和 `node_modules`，受保护系统路径的直接文件写入会被拒绝。
- 每个 run 可取消；退出、scope 清理和取消会终止待审批操作并尽力终止登记的宿主机进程组，清理接口会等待已登记子进程的退出事件。
- 所有终端命令，以及文件写入、进程控制、记忆修改和敏感浏览器动作，进入 `once/session/always/deny` 审批。针对关机、磁盘格式化、直接删除系统根、fork bomb 和已知云元数据地址的文本规则属于额外防护，不是宿主机安全边界。
- 等待队列、请求体读取时间、事件日志、命令输出、同时运行进程和已完成进程记录均有硬上限。
- 崩溃恢复不自动重放已经开始工具副作用的 run，而是标记为 `needs_review`。

### 数据与集成

- SQLite 使用 WAL 与按线程连接；频道、私人会话、知识库和 Agent scope 均在服务端校验归属与权限。
- Agent 生成附件只从允许的媒体根目录读取，并解析软链后再次校验。
- Agent 内部工具接口使用独立 token，与浏览器 session 分离；凭据和 token 不进入 SSE 事件。
- Firecrawl 生成的环境与 compose override 写入平台数据目录，不修改 submodule 工作树。
- 自动更新只接受干净工作树上的 fast-forward，并复用 `deploy.sh update` 的失败回滚路径。

## 部署要求

- 对公网服务设置 `ENTERPRISE_PUBLIC_BASE_URL=https://你的公网域名`，并让反向代理覆盖客户端提供的转发头。
- 只有可信代理需要真实客户端 IP 时才设置 `ENTERPRISE_TRUSTED_PROXY=1`。
- 不要在正式环境设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1`；首次登录改密后删除初始密码文件。
- 保护 `ENTERPRISE_PLATFORM_DATA` 及平台服务账号。数据库内含密码哈希、OAuth token、session secret 和内部 runtime token。
- 保持 Agent runtime 监听本机地址，不要通过反向代理公开 `8766` 端口。
- 以最小权限运行平台服务账号；不要让该账号读取不希望 Agent 访问的宿主机凭据或系统目录。
- 进程清理基于已登记 PID/进程组，无法保证回收主动通过 `setsid` 脱离进程组的程序，也无法覆盖 sidecar 被强制终止后遗失的登记信息；需要更强保证时应在部署层增加 systemd scope/cgroup 或等价控制。
- 若宿主机上存在云实例元数据或内部管理网络，应在主机/网络层额外阻断；命令文本规则不能替代网络隔离。

## 验证命令

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests

cd agent-runtime
npm ci
npm run check
npm test
npm run build
```

前端改动还需在 `frontend/` 执行 `npm ci`、`npm run check`、`npm test` 和 `npm run build`。
