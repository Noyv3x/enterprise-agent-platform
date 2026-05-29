# 上线前项目内安全检查

日期：2026-05-27

## 范围

本次检查限定在本仓库项目代码本身：

- `enterprise-agent-platform/enterprise_agent_platform/`
- `enterprise-agent-platform/hermes_plugin/`
- `enterprise-agent-platform/static/`
- 顶层与平台 README、`deploy.sh` 及平台部署引导代码

未检查 frp、Caddy、服务器系统、网络边界、TLS 证书、DNS、防火墙、Docker daemon 安全基线，以及 `hermes-agent/`、`cognee/`、`firecrawl/` 上游 submodule 的内部实现。

## 已完成加固

1. 移除公开部署下的默认 `admin/admin` 引导口令。
   - 未设置 `ENTERPRISE_ADMIN_PASSWORD` 时，平台生成随机初始密码并保存到数据目录的 `bootstrap-admin-password.txt`。
   - 仅显式设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1` 时才允许本地开发使用 `admin/admin`。

2. 提高账号密码下限并增加登录失败限流。
   - 新建账号和重置密码最低 8 位。
   - 同一用户名和客户端连续登录失败达到阈值后返回 `429`。

3. 加固浏览器会话请求。
   - 对 `POST`、`PUT`、`PATCH`、`DELETE` API 请求校验 `Origin` / `Referer`。
   - `ENTERPRISE_PUBLIC_BASE_URL=https://...` 时，登录 Cookie 自动带 `Secure`。
   - Cookie 保持 `HttpOnly` 与 `SameSite=Lax`。

4. 增加 HTTP 安全响应头。
   - `Content-Security-Policy`
   - `X-Frame-Options: DENY`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: same-origin`

5. 限制附件内联展示。
   - 只有 PNG、JPEG、GIF、WebP、BMP 会以内联图片方式返回。
   - SVG、HTML、文本、PDF、Office 等其他上传内容强制走 `Content-Disposition: attachment`，降低同源附件 XSS 风险。

6. 隐藏 500 错误细节。
   - HTTP 响应只返回通用 `internal server error`。
   - 详细 traceback 仅写入服务端 stderr / 日志。

7. 校验异常 `Content-Length`。
   - 非数字或负数长度返回 `400`，避免落入通用异常路径。

## 二次加固（2026-05-28）

在上线前复审基础上，进一步修复了运行时集成与部署路径中的问题：

1. 会话签名密钥持久化。未设置 `ENTERPRISE_SESSION_SECRET` 时，密钥首次启动生成后写入数据库（secret），重启不再注销所有会话；设置 env 时仍以 env 为准。
2. 限制 Agent `MEDIA:` 文件读取范围。生成附件只允许读取工作区与系统临时目录（可经 `ENTERPRISE_MEDIA_ROOTS` 扩展），并解析软链后校验，杜绝读取 `data` 目录密钥或 `/etc/passwd` 等任意主机文件。
3. 约束托管 Hermes 源路径。`repo_path` 必须存在、含 `pyproject.toml` 且位于受信目录（绑定子模块及其父目录，可经 `ENTERPRISE_HERMES_REPO_ALLOWED_ROOTS` 扩展），消除 Web 管理员触发任意 `pip install -e` 的 RCE 面。
4. 托管 Hermes/Cognee `.env` 以 0600 原子写入，与 `auth.json` 一致，避免 `API_SERVER_KEY` / agent token 组/全局可读。
5. CSRF 与登录限流的可信代理边界。仅在 `ENTERPRISE_TRUSTED_PROXY=1` 时信任 `X-Forwarded-*`；cookie 写请求缺 `Origin`/`Referer` 时拒绝（bearer 客户端豁免）；新增按账号的全局失败上限。
6. 会话 token 可吊销。改密、改角色/权限组、停用或显式吊销会递增 `token_version`，使既有 token 立即失效。
7. 频道与知识库读取授权。频道历史读取需 `read_workspace`、私聊按用户归属隔离；知识库读取端点需 `read_workspace`（agent-tool 边界仍由 agent token 单独鉴权）。
8. 私人 Agent 容器隔离加固。Docker 后端默认 `--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit`、`--memory`，可配 `--cpus`/`--network`。
9. 前端纵深防御。锚点 `href` 仅允许 http(s)/相对/mailto/tel；401 自动跳登录；非 JSON 响应不再抛裸异常；移除登录框默认用户名。
10. 可靠性。SQLite 改为按线程连接 + WAL（去除全局串行锁）；Agent 队列与 OAuth 会话有界化；Cognee 摄取移至后台线程，不再阻塞请求。

## 检查结论

当前项目代码在本次范围内未发现仍需阻断上线的高危问题。已修复的主要风险集中在公开入口会暴露的默认弱口令、CSRF、附件同源脚本执行、错误信息泄露和登录爆破，以及二次加固覆盖的会话密钥稳定性、Agent 任意文件读取、管理员可控 RCE 面、运行时密钥文件权限、频道/知识库读取授权与容器隔离。

## 上线前项目配置要求

- 生产环境设置 `ENTERPRISE_PUBLIC_BASE_URL=https://你的公网域名`。
- 若平台位于反向代理之后并需按真实客户端 IP 限流，设置 `ENTERPRISE_TRUSTED_PROXY=1`（仅在代理会重写 `X-Forwarded-*` 时）。
- 生产环境不要设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1`。
- 首次启动推荐设置 `ENTERPRISE_ADMIN_PASSWORD`；如使用生成文件，首次登录并修改密码后删除 `bootstrap-admin-password.txt`。
- 可显式设置 `ENTERPRISE_SESSION_SECRET` 由运维统一管理签名密钥；不设置时平台会在数据库中持久化一份。
- 保持平台服务监听内网或本机地址，默认 `127.0.0.1:8765` 适合放在 Caddy 后面。
- 保护 `ENTERPRISE_PLATFORM_DATA` 数据目录权限；平台数据库中保存账号哈希、会话相关密钥、OAuth token 和运行时密钥。

## 验证

已执行：

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform hermes_plugin tests
```

结果：51 项单元测试通过，编译检查通过。
