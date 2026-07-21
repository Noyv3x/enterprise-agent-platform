# 外部集成

本文定义平台与模型 OAuth、SearXNG、Firecrawl、Camoufox、Cognee 和 Telegram 的边界。部署方法见[托管服务与部署](../operations/deployment.md)，配置入口见[配置参考](../reference/configuration.md)。

## 通用原则

- 集成适配器属于平台代码，上游 submodule 和 npm 包不属于产品代码。
- 托管配置、数据库、profile、缓存和日志写入平台数据目录，不能写入上游仓库。
- 托管 HTTP endpoint 必须监听数值回环地址。外置 SearXNG 仍只接受由运维管理的本机数值回环 endpoint；外置 Agent Runtime 与 Firecrawl 可以使用受信任的 HTTP(S) 服务，但必须由运维提供认证并承担网络信任边界。Camoufox 当前只支持平台托管模式，关闭托管即关闭浏览器能力。
- 集成不可用时应返回对应能力的明确错误，不得破坏平台本地数据。
- 凭据只在需要时从 Python secret store 解析，不能进入模型可控 metadata。

## 模型 OAuth

平台只提供 Codex OAuth 和 Grok OAuth。Codex 使用设备码流程；Grok 使用浏览器授权后粘贴本机 callback URL 的流程。Python 自行完成 OAuth 会话、state/PKCE 校验、token 交换、刷新、导入导出和持久化。

Runtime 的锁定 Pi 元数据是可执行模型的唯一能力目录。Codex 的账号模型目录与 Runtime 目录求交；xAI 的模型接口可能不完整，因此只作为可用性信号，不能错误地缩成完整 allowlist。目录失败时可以使用带 stale 标志的最近缓存，但不能引入 Runtime 未知模型。文档不得硬编码动态模型 ID 清单。

## SearXNG 搜索

网页搜索直接请求平台管理的 SearXNG JSON `/search`，不经过 Firecrawl。请求固定为 general 类别，可带语言和页码；平台在统一搜索预算内读取若干页，过滤重复、格式错误、本地地址和含敏感凭据参数的 URL，直到达到请求数量。

返回给 Agent 的搜索项包括标题、URL、描述和稳定位置。搜索不会自动获取完整正文；部分搜索源失败时返回 warning，而不是把已有结果丢弃。结果数量、上游超时与响应上限由搜索适配器配置和测试约束，不属于 Agent Runtime 跨层契约。

托管 SearXNG 使用平台生成的 Compose 与 settings，镜像按 digest 锁定，仅发布到数值回环地址。关闭托管后，外部 endpoint 仍必须是本机数值回环地址。

## Firecrawl 提取

`web extract/read` 才调用 Firecrawl `/v1/scrape`，请求 markdown 与 HTML，并优先返回 markdown。每个原始 URL 和 provider 返回的最终 URL 都要经过外部 URL 校验；内容按调用字符预算裁剪。

Firecrawl submodule 是上游源。平台在数据目录生成 `.env` 和 Compose override，使用 digest 锁定镜像；停止服务必须执行 Compose teardown，不能只杀死 CLI 进程而遗留容器。

关闭托管后，平台可以调用运维提供的 HTTP(S) Firecrawl endpoint，并按需使用作为平台 secret 管理的 `FIRECRAWL_API_KEY`。标准 service 直接从平台 secret store 读取 key，不把它复制到 systemd unit；外置服务地址必须是无内嵌凭据的有效 base URL，携带 API key 的调用拒绝重定向。公开网页的提取目标仍逐项通过 DNS 感知 SSRF 校验，不能因为 provider 由运维信任就放宽目标 URL 校验。

## Camoufox 浏览器

平台管理 `camofox-browser` 服务、camoufox-js、Playwright Core 和锁定的浏览器资产。托管启动明确忽略宿主机遗留 `DISPLAY`，由部署准备图形依赖并采用兼容的 headless/Xvfb 路径。

浏览器身份由 scope key 哈希派生，模型不能指定 `userId` 或 `sessionKey`。每次 tab 操作都带派生身份，页面 URL 在操作前后重新校验。浏览器按可信成员模型允许访问普通内网和回环页面，但拒绝云元数据、链路本地、多播、保留、不可路由目标及 URL 内嵌凭据。支持 tab、导航、snapshot、截图/vision、链接、图片、下载列表、结构化提取和常见交互；console 不执行任意 JavaScript。

浏览器预览只读取已存在 tab 的低频 viewport 截图。打开预览不能创建 workspace、启动浏览器、打开 tab、导航或改变当前 tab。委派 Agent 使用派生浏览器身份，父界面可只读查看当前观察到的 scope family。

## Cognee

本地 SQLite/FTS 知识库始终可用。`local` 模式完全不调用 Cognee；`hybrid` 和 `cognee` 模式尝试将文档摄取到指定 dataset，并将 Cognee 搜索结果与本地结果合并。

Cognee 由 Python bridge 直接导入，不是独立 HTTP 服务。平台数据目录保存其 data、system、cache、logs 和 `.env`。平台后台 worker 是摄取的异步边界；调用 Cognee 时要等待一次 graph construction 的真实终态，不能让短生命周期 event loop 留下伪成功任务。

## Telegram

Telegram Gateway 只处理私聊，忽略群组、超级群组和频道。用户在私人 Agent 界面生成短时绑定码，通过 `/link CODE` 或 `/start CODE` 绑定 Telegram 身份。

update id 是入站去重边界；未确认的 webhook/long-poll update 可在重启后重新领取。出站回复使用持久 delivery job；已经开始发送但结果未知的任务进入 `needs_review`，不能盲目重复。停用或轮换 bot 时先吊销旧 sender generation，再停止 transport。

## 上游边界

`cognee/` 和 `firecrawl/` 是 Git submodule。常规产品变更不得在其中创建提交、分支或推送，也不得更新 pinned revision，除非任务明确要求升级上游。Agent 行为应实现于 `agent-runtime/` 或 Python 适配器；浏览器补丁实现于平台拥有的 `camofox-runtime/`。
