# 安全与信任边界

本文是当前安全设计的规范说明。历史检查记录位于 `../audits/`，不替代本文。执行细节见 [Agent Runtime](agent-runtime.md)，部署要求见[部署](../operations/deployment.md)。

## 信任模型

ubitech agent 面向彼此可信的成员。所有 Agent 以同一个平台服务账号在宿主机执行，workspace、session、memory 和浏览器 Profile 提供逻辑隔离，不提供抵抗恶意租户的 OS 隔离。

部署方必须把该服务账号可读取、写入和联网的范围控制在可接受水平。审批、路径校验和命令文本规则是纵深防护，不能替代最小权限、网络隔离、容器、cgroup 或独立主机。

## 认证与权限

密码使用 PBKDF2-SHA256 和随机盐。登录失败按客户端与账号限流，并有固定 dummy hash 降低用户名时序泄漏。用户停用、改密、权限变化或显式吊销会推进 token version，使旧会话失效。

浏览器会话由 HMAC 签名 token 承载。Cookie 使用 `HttpOnly` 和 `SameSite=Lax`；公共 URL 为 HTTPS 时增加 `Secure`。携带 Cookie 的写请求必须提供允许的 Origin 或 Referer；只有运维明确启用可信代理后才使用转发头。

权限必须在 Python 服务端检查。前端路由、隐藏按钮和角色标签不是授权边界。内部 Agent 工具使用独立 bearer token，不接受浏览器 session 代替。

## 网络边界

平台托管的 Agent Runtime、SearXNG、Firecrawl 和 Camoufox 必须使用无内嵌凭据的数值回环 endpoint；外置 SearXNG 仍只允许本机数值回环，Camoufox 当前不提供外置模式。外置 Agent Runtime 与 Firecrawl 可以由受信任运维配置为 HTTP(S) endpoint，但凭据必须通过 header 传递，不能内嵌在 URL 中；携带凭据的内部服务请求不得跟随重定向。Runtime 的所有接口，包括健康检查，都需要 bearer token；缺少 token 时 Runtime 必须拒绝启动。外置 Runtime 会获得 Agent 请求与宿主机工作上下文，必须置于等价的受控网络和认证边界内，不得把 Runtime 端口或内部工具路由裸露到公网。

搜索结果和 Firecrawl 提取 URL 只允许公开 HTTP(S)，拒绝内嵌凭据、回环、私网、链路本地地址、云元数据及敏感查询参数；搜索结果的轻量过滤不代替提取前的 DNS 感知 SSRF 校验。

浏览器是受信成员操作宿主机网络的工作工具，允许正常访问回环与内网 HTTP(S)。浏览器导航仍拒绝内嵌凭据、云元数据、链路本地、多播、保留和不可路由目标，并在操作前后重新校验。部署方必须把“Agent 可浏览内网”纳入服务账号和网络信任边界，不能把公开网页提取的 SSRF 策略错误套用为浏览器隔离承诺。

GitHub 自动更新 webhook 使用 HMAC 签名；Telegram webhook 使用不可猜 secret path。运维必须在边界代理覆盖客户端提供的转发头。

## 宿主机工具

审批决策为 `once`、`session`、`always` 或 `deny`。下列操作必须审批：

- 所有 terminal 命令；
- 文件创建、修改和补丁；
- workspace 外读取与搜索；
- 主动进程控制；
- 已提交记忆、技能和计划修改；
- 点击、输入、下载、关闭等敏感浏览器动作。

`always` 按 Agent 授权 scope 持久化；`session` 只在当前 lifecycle 有效。无人值守计划任务只能使用事先存在的持久 `always` 授权，且不能修改计划本身。

直接文件工具拒绝受保护系统树、进程凭据/内存和 Docker socket。命令文本额外拦截关机、磁盘格式化、删除系统根、fork bomb、云元数据及 Docker socket，但 shell 的表达能力意味着这些规则永远不是完整沙箱。

所有子进程移除名称疑似 secret、token、password、API key、credential 或 private key 的环境变量。取消和 scope cleanup 尽力终止登记进程组；主动 `setsid` 脱离或 Runtime 被强杀后遗失登记的信息需要部署层控制处理。

## 文件与附件

平台数据根、workspace 与 Runtime 根必须由服务账号拥有、不是符号链接，并收紧目录和文件权限。workspace 路径的每个组成部分都要重新检查符号链接。

上传文件有数量、单文件、总量、账号配额和全局配额；名称和 MIME 在服务端规范化。只有允许的位图格式可以内联，其余主动下载。Agent 生成附件只能从 workspace、平台管理的媒体目录和显式 `ENTERPRISE_MEDIA_ROOTS` 返回，并在解析真实路径后再次校验。

## 凭据与敏感数据

OAuth refresh token、session secret、内部 token 和其它 secret 保存在平台 SQLite `settings` 表，并用 `secret` 标志控制展示；数据目录和数据库文件依靠宿主机权限保护。当前没有应用层静态加密，文档和界面不得宣称“加密存储”。

OAuth token 不得写入 Runtime metadata、session、SSE、日志、workspace 或 Git。Runtime 只在模型调用时从 Python 获取当前访问凭据。OAuth 导出文件本身包含敏感信息，必须由管理员像密钥一样处理。

## 不可信模型数据

记忆召回、知识、搜索结果、网页、历史会话、附件文字和技能支持文件都属于不可信数据。它们必须使用结构化边界注入，不得被描述成更高优先级指令。模型提供的 owner、scope、provider endpoint、API 类型和浏览器 user id 均不能覆盖可信 Run context。

## 安全变更要求

涉及认证、权限、路径、内部协议、凭据、工具审批、进程或自动更新的变更必须先修改本文或对应设计文档，再修改实现，并增加滥用与恢复测试。Run 空闲、模型轮次和 terminal 默认超时只引用 [`runtime-policy.json`](../contracts/runtime-policy.json)；其它安全边界由对应配置参考和测试约束。
