# 外部集成

本文定义平台与模型 OAuth、SearXNG、Firecrawl、Camoufox、Cognee 和 Telegram 的边界。部署方法见[部署](../operations/deployment.md)，配置入口见[配置参考](../reference/configuration.md)。

## 发布与通用原则

- 集成适配器属于产品代码；上游 Git 仓库和缓存不属于产品运行数据。
- Cognee 与 Firecrawl 的官方 URL 和精确 revision 由 [`upstream-sources.json`](../contracts/upstream-sources.json) 锁定。CI 在隔离构建上下文中获取、验证和构建，部署机只按 release manifest 拉取镜像，不下载上游源码。
- Platform、Runtime 和集成容器不得访问 Docker socket；生命周期由宿主管理器统一控制。
- 配置、数据库、Profile、缓存和日志写入数据根的明确 bind mount，不能写进镜像或源码目录。
- 集成不可用时返回对应能力的明确 degraded/error，不得破坏消息、任务与本地知识数据。
- 凭据只注入需要它的服务，不能进入模型可控 metadata、Sandbox 环境或日志。

## 模型 OAuth

平台提供 Codex OAuth 和 Grok OAuth。Codex 使用设备码流程；Grok 使用浏览器授权后粘贴 callback URL 的流程。Python 完成 OAuth 会话、state/PKCE 校验、token 交换、刷新、导入导出和持久化。

Runtime 的锁定 Pi 元数据是可执行模型的唯一能力目录。供应商发现目录只能与 Runtime 目录求交或作为可用性提示，不能扩展可执行集合。目录失败时可以使用带 stale 标志的最近缓存。文档不得硬编码动态模型 ID 清单。

## SearXNG 搜索

网页搜索直接请求受管 SearXNG JSON `/search`，不经过 Firecrawl。请求固定为 general 类别，可带语言和页码；平台在统一预算内读取若干页，过滤重复、格式错误、本地地址和含敏感参数的 URL，直到达到请求数量。

返回给 Agent 的搜索项包括标题、URL、描述和稳定位置。搜索不会自动获取完整正文；部分搜索源失败时返回 warning，而不是丢弃已有结果。SearXNG 镜像与配置由发布清单锁定，只接入私有容器网络。SearXNG 容器必须显式以宿主部署用户 UID/GID 运行，使 Manager 创建的 `0600` settings 与 `0700` cache/config 根可以直接读写；不得依赖锁定镜像当前以 root 启动或由上游 entrypoint 递归改写 bind mount 所有权。

## Firecrawl 提取

`web extract/read` 调用受管 Firecrawl `/v1/scrape`，请求 markdown 与 HTML并优先返回 markdown。每个原始 URL 和最终 URL 都经过公开 URL 与 DNS 感知 SSRF 校验；内容按调用预算裁剪。

CI 从源码契约指定的 Compose 文件解析并精确核对服务清单，再构建或锁定所有服务镜像 digest。发布清单没有完整 Firecrawl digest 集时不能发布。Manager 用稳定 project label、显式 bind mount 和私有网络启动它；Compose 成功后仍需 HTTP 探测，停止时移除 orphan。部署机不保留 Firecrawl checkout。

Firecrawl API key 作为 Platform secret 注入调用方，不写入 Compose 文件、Manager journal 或 URL；携带 key 的请求拒绝重定向。

## Camoufox 浏览器

共享 Camoufox 容器包含平台拥有的 camoufox-js 补丁、Playwright Core、锁定浏览器资产和 Xvfb/headless 依赖，不读取宿主 `DISPLAY`。Profile、Cookie、下载与 trace 按 scope identity 写入 bind mount。浏览器包的 `version.json` 必须记录锁定 GitHub tag 的真实 release（当前为 `beta.25`），不能把架构资产文件名中的 `alpha.*` 构建号当作 release；Camofox server 与 camoufox-js 必须解析到同一个持久 cache 目录。容器主 API 可以监听私有容器网络的 `0.0.0.0`，但浏览器进程使用的 connection-pinning proxy 必须始终只监听并返回 loopback 地址；两者不得复用 bind host。

浏览器身份由 scope key 哈希派生，模型不能指定 user id、profile 路径或 session key。每次操作都带派生身份，URL 在操作前后重新校验。浏览器按可信成员模型允许普通内网和回环页面，但拒绝云元数据、链路本地、多播、保留、不可路由目标及 URL 内嵌凭据。

支持 tab、导航、snapshot、截图/vision、链接、图片、下载列表、结构化提取和常见交互；console 不执行任意 JavaScript。预览只读取已有 tab 的低频 viewport 帧，打开预览不能启动浏览器、创建 tab、导航或改变当前 tab。

## Cognee

本地 SQLite/FTS 知识库始终可用。`local` 模式不调用 Cognee；`hybrid` 和 `cognee` 模式尝试摄取到指定 dataset，并合并 Cognee 与本地结果。

Cognee 精确 revision 在 Platform 镜像构建时安装为分发版，运行时不把源码加入 `sys.path`。其 data、system、cache、logs 与 `.env` 位于 bind mount。Platform 后台 worker 是摄取异步边界；调用要等待 graph construction 的真实终态，不能留下短生命周期 event loop 的伪成功任务。

## 不可信内容

搜索、提取、浏览器文本、知识结果、记忆、历史会话、计划定义/历史和 Skill 附件都可能包含间接提示词注入。返回模型前必须进入防伪闭合的 `untrusted_tool_result` 数据边界，并先中和载荷伪造的同名标签；图片保持图片块，伴随文本仍使用相同边界。

结构化边界是主要语义防线。共享威胁扫描器只作纵深防护：输入先 NFKC 归一化，检测不可见/双向 Unicode，并使用有界规则。长期记忆、Skill 主指令和计划 prompt 在写入及加载/执行时复查；普通网页内容不因关键词被删除，而是保持可见并始终作为不可信数据。

## Telegram

Telegram Gateway 只处理私聊，忽略群组、超级群组和频道。用户在私人 Agent 界面生成短时绑定码，通过 `/link CODE` 或 `/start CODE` 绑定身份。

update id 是入站去重边界；未确认 update 可在重启后重新领取。出站回复使用持久 delivery job；已开始发送但结果未知的任务进入 `needs_review`，不能盲目重复。停用或轮换 bot 时先吊销旧 sender generation，再停止 transport。

## 上游边界

本仓库不包含 Cognee 或 Firecrawl 的 gitlink、vendored tree 或镜像副本。临时构建 checkout 不得承载产品修改或被推送。平台行为实现于 Python adapter、Agent Runtime、Manager 或平台生成配置；浏览器补丁实现于 `camofox-runtime/`。升级上游先修改源码契约并通过镜像集成验证。
