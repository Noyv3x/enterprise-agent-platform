# 文档工作流

`docs/` 记录用户可见行为、安全边界和跨组件契约。行为或契约变化时先改对应规范；纯实现重构不需要追加过程记录。每条规则只有一个权威来源，其它地方链接过去；不要把源码结构或测试实现写成产品规范。

## 机器契约

跨语言的精确值由 `docs/contracts/` 中的 JSON 定义，生成目标以 `scripts/docs_sync.py` 的 `CONTRACTS` 为准，不手改生成代码：

- [runtime-policy.json](../contracts/runtime-policy.json)：Go、Python、Runtime 和前端常量。
- [container-platform.json](../contracts/container-platform.json)：Go、Python、Runtime 和前端常量。
- [technical-profiles.json](../contracts/technical-profiles.json)：Go、Python 和 Runtime 常量。
- [upstream-sources.json](../contracts/upstream-sources.json)：构建脚本直接读取的上游输入。

## 命令

在仓库根目录：

```sh
python3 scripts/docs_sync.py sync   # 契约变化后重新生成
python3 scripts/docs_sync.py check  # 校验当前文件树
./scripts/test.sh full             # 交付前完整门禁
```

`check` 验证契约字段和边界、生成字节和路径安全、本地文档链接及标题锚点；不证明语义正确。完整本地门禁和 Quality CI 各检查一次；单组件命令见[测试与验证](testing.md)。

## 发布兼容性清单

修改测试、工作流或打包时，确认当前已安装 Manager 仍能消费候选版本：

- 保留 `.github/workflows/quality.yml` 和工作流名称 `Quality gates`。发布由成功的 Quality `workflow_run` 事件授权，只接受同仓库 `main` push 的精确 commit；PR 或未成功的运行不能发布。
- PR 权限保持只读，第三方 actions 固定完整提交摘要；Quality 失败、取消或未完成均不授权发布。
- 保持清单 schema 2、Manager protocol 2、十个镜像键、双架构 Manager 和八个公开资产；镜像使用不可变摘要，资产和字节身份完整后才推进 latest。
- 数据库迁移沿用受控入口，当前/上一版本仍能读取保留的数据和快照；不得降低数据库版本或削弱身份、审批、维护门和回滚边界。
- 每个合格的 main commit 都进入发布，不按文件类型跳过，以免遗漏此前尚未发布的产品变更；发布与 latest 顺序见[发布通道](../operations/auto-update.md#发布通道)。

真实安装、恢复和发布证据见[部署与冒烟](testing.md#部署与冒烟)。
