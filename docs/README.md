# Agent Platform 文档

本目录是 Agent Platform 当前设计的唯一真相源。代码、配置、测试和运维行为应实现这里描述的设计；发生冲突时，先修正文档中的目标设计，再同步代码。此名称是未配置部署品牌时的中性文档称呼，不限制管理员部署后设置的公开品牌。

## 设计

- [产品边界](design/product.md)
- [系统架构](design/system-architecture.md)
- [前端设计](design/frontend.md)
- [Agent Runtime](design/agent-runtime.md)
- [数据、记忆与会话](design/data-memory-sessions.md)
- [安全与信任边界](design/security-and-trust.md)
- [外部集成](design/integrations.md)

## 参考

- [配置参考](reference/configuration.md)
- [Runtime API](reference/runtime-api.md)
- [数据目录](reference/data-layout.md)
- [Runtime 精确策略契约](contracts/runtime-policy.json)

## 运维

- [部署](operations/deployment.md)
- [自动更新](operations/auto-update.md)

## 开发

- [仓库结构与边界](development/repository.md)
- [测试与质量门禁](development/testing.md)
- [文档与代码同步流程](development/documentation-workflow.md)
- [文档与代码域映射](domains.json)

## 决策与审计

- [架构决策记录](decisions/README.md)
- [文档作为设计真相源](decisions/0001-documentation-is-design-source.md)
- [可配置品牌与中性运行身份](decisions/0004-configurable-branding-and-neutral-runtime-identity.md)
