# 文档与代码同步流程

`docs/` 是 ubitech agent 当前设计的唯一真相源。设计约束、运行边界、公开契约和运维行为应先在这里修改，再落实到代码与测试。根目录的 `AGENTS.md`、`CLAUDE.md` 已弃用，不得重新建立。

完整文档入口见 [文档索引](../README.md)，代码域映射见 [`domains.json`](../domains.json)。

## 修改顺序

1. 在对应设计或参考文档中描述期望的最终行为。
2. 如果精确默认值、边界或枚举跨语言/进程共享，或被声明为稳定设计契约，先修改相应的机器可读契约；当前跨层 Runtime 策略契约为 [`runtime-policy.json`](../contracts/runtime-policy.json)。
3. 运行 `python3 scripts/docs_sync.py sync`，生成各语言消费的契约模块。
4. 修改生产代码，并补充或更新映射域中的验收测试。
5. 运行 `python3 scripts/docs_sync.py check` 和该代码域的完整测试。
6. 提交前用 `check-change` 检查基准提交到待提交版本之间是否双向同步。

## 命令

```bash
python3 scripts/docs_sync.py sync
python3 scripts/docs_sync.py check
python3 scripts/docs_sync.py check-change --base <base-sha> --head <head-sha>
python3 scripts/docs_sync.py check-change --base HEAD --head INDEX
python3 scripts/docs_sync.py check-change --base HEAD --head WORKTREE
```

`sync` 只写由契约完整生成的文件，输出不包含时间戳，因此相同输入始终得到相同结果。生成文件禁止手工编辑。

Manifest、canonical 文档、机器契约及生成目标都必须位于仓库内，路径链不能借助符号链接改写其它文件。生成目标必须是普通文件且不可执行。校验不要求固定为 `0644`：Git 只保存可执行位，实际读取权限会受部署机 `umask` 影响；`sync` 创建或修复目标时使用安全的非执行权限。生成到 JavaScript/TypeScript 的全部整数及单位换算结果必须保持在 `Number.MAX_SAFE_INTEGER` 内；直接交给 Node timer 的毫秒值还必须位于其有效延迟范围内。

`check` 验证当前树中的以下不变量：

- 代码域、设计文档、测试和契约路径有效；
- 自有生产代码均映射到至少一个文档域；同一路径匹配多个域时，所有匹配域都必须共同同步；
- 应纳入同步的设计文档均登记在域清单中；
- 生成模块与机器可读契约逐字节一致；
- `docs/` 中的本地相对链接没有失效；
- 顶层遗留指令文件没有重新出现。

`check-change` 先运行全部当前树检查。比较两个提交时，以它们的 Git merge-base 到 head 作为变更集，避免落后主线的分支把主线变化误算成自己的修改；是否属于首次 bootstrap 仍以 policy base 上是否已有 manifest 判断。校验同时读取 merge-base 与目标版本的 domain manifest，并按旧、新 coverage 与 owner 的并集归类路径，因此删除 owner、缩窄 coverage、删除文件或把文件 rename 出受管路径都不能绕过原设计域。将 `--head` 设为 `INDEX` 时只检查基准提交、已有提交和暂存快照，防止“已暂存代码、文档仍未暂存”的下一次提交逃逸；设为 `WORKTREE` 时会进一步合并未暂存修改和未跟踪文件。两种本地模式都把 rename 当成删除加新增，并由部署与 `./deploy.sh test` 共同执行。

受管生产路径改变时，它匹配的每个文档域都必须有设计文档或契约改变；设计文档或契约改变时，对应域必须有生产代码、生成模块或验收测试改变。构建配置、依赖 lockfile、前端 public 资产、bundled skill、CI workflow 和上游源码契约同样属于受管生产路径。首次引入 `docs/domains.json` 的提交属于 bootstrap，只执行当前树检查。

## 边界

文档共改门禁能够保证一个最终变更集中的设计与实现被一起审阅，但不能证明作者实际编辑文件的时间顺序，也不能理解任意自然语言是否被正确实现。自动映射是最低 owner/affected-domain 约束；像 Python `service.py` 这样的跨领域聚合文件会映射到多个域，长期应继续拆分，作者和评审者仍需补充路径映射无法识别的真实语义域。跨层或稳定的精确设计值必须进入机器可读契约并生成代码；单模块内部调优值可由对应实现与测试约束，但不得在文档中复制另一份易漂移数值。行为约束必须由对应测试验证。不要用仅记录文档 hash 的文件代替可执行契约。

普通部署先验证当前文档树、最近提交和工作区共改关系；自动更新在 fast-forward 后、启动新版本前验证目标提交，失败进入既有 rollback。CI、更新门和本地测试使用同一脚本，不能各自维护一套规则。

部署工作流的静态验收必须先按顶层 job 边界提取目标 job，再检查其权限、依赖和安全清理片段，不能只在整份 workflow 中搜索字符串。尤其是 Compose 发布冒烟的异 UID 临时目录前缀、路径 guard 与提权清理必须同时出现在 `compose-smoke` job 内，避免相同片段误落到其它 job 仍被判为通过。

Cognee 与 Firecrawl 不进入产品 Git tree。它们的 URL、revision 和必需路径由 [`upstream-sources.json`](../contracts/upstream-sources.json) 定义并属于集成设计域；修改契约必须同步部署实现或验收测试。数据目录中的受管 checkout 不是 canonical 文档或受管产品代码。
