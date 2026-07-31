# 0004：可配置品牌与中性运行身份

- 状态：accepted
- 日期：2026-07-31

## 背景

产品需要作为可独立供应的软件部署。发布物不能把源码维护方或部署方的名称、Logo、颜色和 Agent 自称固化到界面、提示词或离线页面；同时，现役 Manager、数据目录、Docker 资源和更新 journal 已把旧名称作为持久运行身份，直接替换会破坏更新、恢复与数据所有权证明。

## 决定

品牌成为部署后由管理员管理的公开配置。名称、Agent 显示名、颜色和受限图片只影响展示，不参与路径、环境变量、容器名、权限、数据库键、cookie、事件名或协议路由。未配置时使用中性名称、文字标识和中性图标；仓库不携带维护方品牌资产。匿名登录、认证后界面、通知、导出内容中的展示标题、Agent prompt、维护页和错误页消费同一公开品牌投影或中性降级值；导出文件名继续使用稳定的中性技术命名空间，不能从可变品牌派生。

内部持久身份也采用中性命名，但不能在普通应用更新中原地批量替换。真实迁移和清理由两次不可变发布组成，但在它们之前必须有两个不会触发迁移的普通能力发布：source-profile 发布只集中技术身份并严格识别、无副作用拒绝交接清单；source-owner 发布一次性交付完整身份 Router、迁移 coordinator、外置 journal、持久 helper、恢复与启动发现，并先在现役源身份下完成稳定性和断电恢复验收。Router 必须在普通 operation 取得所有权以前运行；target profile 只能由完全验证的 journal 注入，不能由 manifest、配置、环境或目标目录选择。

随后桥接发布在 Manager 空闲且没有 candidate、activation、watchdog、finalize 或活动 Sandbox 调用时建立持久 journal 和恢复快照。source-owner 把事务所有权移交给跨重启 helper 后，helper 是停止写入者、搬移受管数据、切换 listener/unit 与推进 journal 的唯一 writer；目标 Manager 只能为其精确 stable inode 和目标身份产出权威 `target_ack` 证明，helper 验证并持久化但不得自行生成或代签。目标 Manager 的普通 state 与自更新历史从受验证桥接身份重新建立，不复制源 Candidate、Activation、operation 或 recovery journal。结构化迁移只变更机器拥有的 identity/path/marker/ownership 字段，不搜索替换用户消息、记忆、Skill、session、附件或其它用户文本。验收 Platform、Runtime、数据库、工作区、集成服务、自动更新与回滚后才退役旧身份。

桥接 release 在 promotion 前保持 draft，只有受保护 workflow 验证现役 source-owner Manager 的签名部署回执后才进入 main 更新通道；最后清理 release 同样等待目标 Manager 的 `target_ack + committed` 签名回执。回执绑定部署、profile、精确 generation 和运行二进制身份，不能替代工件摘要、质量门或 Git ancestry。清理版同时建立 target-only 的 manifest/protocol schema barrier，确保仍处于源身份的实例在任何副作用前拒绝它；随后删除桥接入口和旧名称兼容，只保留中性运行身份。具体交接和发布顺序分别见[部署](../operations/deployment.md#技术命名空间交接)与[自动更新](../operations/auto-update.md#技术命名空间迁移发布)。

历史 journal 不通过改写内容伪装成新路径，迁移不使用符号链接跨越受管根。品牌配置不得改变或重新触发内部身份迁移。

## 后果

- 同一发布物可由不同部署独立设置品牌，不需要重新构建镜像；
- 品牌输入属于不可信公开文本和图片，必须经过严格校验，不能直接成为提示词指令；
- 登录前品牌读取只暴露公开投影，不泄露其它系统设置；
- Manager 无法读取 Platform 时仍能生成中性维护页；
- 内部命名归零需要一次受控交接，但交接完成后的新基线不保留永久兼容层；
- 桥接和清理的通道提升依赖可验证部署回执，不能仅凭 release 构建成功或人工观察；
- 目标 Manager 拥有全新控制状态，产品数据保持原义而不是通过全局文本替换“去品牌”；
- 改变显示品牌不会移动数据、重命名容器或使用户登出。

## 替代方案

在构建时替换字符串和图片会制造部署专用镜像并遗漏维护页、通知和 Agent prompt；让品牌名派生技术标识会使改名成为数据迁移；直接全局替换现役内部名称无法安全处理 Manager 自更新和恢复所有权。以上方案均不采用。
