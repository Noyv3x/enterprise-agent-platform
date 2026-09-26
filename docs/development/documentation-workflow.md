# 文档工作流

`docs/` 记录产品意图、跨组件规则和对外契约；代码负责实现，测试负责证明。根目录的 `AGENTS.md` 和 `README.md` 只做规则入口和导航，不维护第二份规范。

## 文档写什么、不写什么

文档的读者是以后接手这个仓库的人（包括 AI）。写进文档的，应该是**读代码很难看出来、改错了会出事**的东西：

- 用户能观察到的行为，以及必须守住的规则（例如"切换账号后迟到的结果必须丢弃""宿主机执行必须逐次审批"）；
- 跨组件的契约：接口字段、配置归属、磁盘布局、发布协议；
- 做出某个选择的理由，放在[架构决策](../decisions/README.md)里。

**不写**实现细节：组件或函数怎么拆、用了哪个 hook、CSS 怎么分层、动画曲线和像素值、测试怎么组织。这些以代码为准；写进文档只会让每次重构都要跟着改文档，然后文档越来越不准。判断标准：**换一种实现方式但行为不变时，这句话需要改吗？需要改，它就不该写在文档里。**

写法：

- 用正常的中文：短段落、要点列表、表格用于并列的事实。不用斜杠堆砌、缩写和电报体。
- 每条规则只在一个地方完整定义，其它地方链接过去。精确的数值放在机器契约里，文档引用它们，不抄默认值。
- 文档之间的链接可以带章节锚点，改标题时记得同步链接（检查会报错）。

## 什么时候改文档

1. **行为或契约变化时，先改文档**：接口、配置、持久格式、用户可见行为、安全边界变化前，先更新对应规范；跨语言的精确值先改机器契约，再生成代码、同步实现和行为测试。
2. **修 bug、重构、补测试不需要改文档**，除非发现文档本身写错了。不要为了"同步"而给文档追加一句。
3. 发现代码和文档冲突时，先确认正确的行为和它的权威来源，再决定改哪边；不靠改一句文档掩盖实现上的问题。

交付前完成[测试与验证](testing.md)里的门禁。检查只能证明结构和链接，文档内容是否正确要靠审查。

## 机器契约

跨组件共享的精确值放在 `docs/contracts/` 下的 JSON 里，由 `scripts/docs_sync.py` 生成各语言的只读常量：

| 契约 | 生成的代码 |
| --- | --- |
| [runtime-policy.json](../contracts/runtime-policy.json) | Go、Python、Runtime 和前端的 TypeScript |
| [container-platform.json](../contracts/container-platform.json) | Go、Python、Runtime 和前端的 TypeScript |
| [technical-profiles.json](../contracts/technical-profiles.json) | Go、Python、Runtime 的 TypeScript |
| [upstream-sources.json](../contracts/upstream-sources.json) | 不生成代码，由构建脚本直接读取校验后的 JSON |

契约和生成目标的完整清单写在 `scripts/docs_sync.py` 的 `CONTRACTS` 里，是封闭集合。新增契约时同时修改那里、加上校验和生成逻辑，并补测试。

## 命令

在仓库根目录：

```sh
python3 scripts/docs_sync.py sync    # 重新生成所有契约的代码
python3 scripts/docs_sync.py check   # 检查当前文件树
```

- `sync` 只写登记过的生成文件；不要手改生成的代码。
- `check` 检查：
  - 每份契约都能通过严格校验（封闭字段、类型、边界、JavaScript 安全整数、Node 定时器上限），且生成的代码逐字节一致、不可执行；
  - 契约源文件和生成目标不越出仓库、不经过符号链接、是普通文件；
  - `docs/`、根目录 `AGENTS.md`、`README.md` 和组件 README 里的本地链接都存在，带锚点的链接指向真实的标题。
- `check` **不检查**文档内容是否正确、是否与实现一致。

`./scripts/test.sh` 和 CI 都会先运行一次 `check`。只改 `docs/` 下直接存放的 `.md` 文件（以及根目录的 `AGENTS.md`、`README.md`）不会触发新版本发布，规则见[发布资格](../operations/auto-update.md#发布通道)。
