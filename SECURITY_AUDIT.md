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

## 检查结论

当前项目代码在本次范围内未发现仍需阻断上线的高危问题。已修复的主要风险集中在公开入口会暴露的默认弱口令、CSRF、附件同源脚本执行、错误信息泄露和登录爆破。

## 上线前项目配置要求

- 生产环境设置 `ENTERPRISE_PUBLIC_BASE_URL=https://你的公网域名`。
- 生产环境不要设置 `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD=1`。
- 首次启动推荐设置 `ENTERPRISE_ADMIN_PASSWORD`；如使用生成文件，首次登录并修改密码后删除 `bootstrap-admin-password.txt`。
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
